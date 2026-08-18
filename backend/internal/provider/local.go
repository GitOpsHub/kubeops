package provider

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/GitOpsHub/kubeops/backend/internal/model"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

type LocalKubernetes struct {
	Provider string
}

func (l LocalKubernetes) Discover(ctx context.Context, source model.CloudSource) ([]model.Cluster, error) {
	path, err := expandPath(source.KubeconfigPath)
	if err != nil {
		return nil, err
	}
	config, err := clientcmd.LoadFromFile(path)
	if err != nil {
		return nil, fmt.Errorf("load kubeconfig %s: %w", path, err)
	}

	contexts, err := selectedContexts(config, source, l.Provider)
	if err != nil {
		return nil, err
	}
	clusters := make([]model.Cluster, 0, len(contexts))
	for _, contextName := range contexts {
		cluster, err := inspectContext(ctx, config, source, l.Provider, contextName)
		if err != nil {
			return nil, err
		}
		clusters = append(clusters, cluster)
	}
	return clusters, nil
}

func selectedContexts(
	config *clientcmdapi.Config,
	source model.CloudSource,
	providerName string,
) ([]string, error) {
	if len(source.Contexts) > 0 {
		// A pinned context missing from a kubeconfig that otherwise loaded is
		// how a deleted local cluster looks — `minikube delete` and Docker
		// Desktop resets erase the context. Failing the sync here would keep
		// the phantom cluster active in the inventory forever; reporting it
		// absent lets the syncer mark it removed, and recreating the cluster
		// restores it on the next sync.
		contexts := make([]string, 0, len(source.Contexts))
		for _, name := range source.Contexts {
			if _, exists := config.Contexts[name]; exists {
				contexts = append(contexts, name)
			}
		}
		sort.Strings(contexts)
		return contexts, nil
	}

	contexts := make([]string, 0)
	for name, contextConfig := range config.Contexts {
		cluster := config.Clusters[contextConfig.Cluster]
		if matchesLocalContext(providerName, name, cluster) {
			contexts = append(contexts, name)
		}
	}
	sort.Strings(contexts)
	return contexts, nil
}

func matchesLocalContext(providerName, contextName string, cluster *clientcmdapi.Cluster) bool {
	name := strings.ToLower(contextName)
	switch providerName {
	case model.ProviderDocker:
		return name == "docker-desktop" ||
			name == "docker-for-desktop" ||
			strings.HasPrefix(name, "kind-") ||
			strings.HasPrefix(name, "k3d-")
	case model.ProviderMinikube:
		if name == "minikube" || strings.HasPrefix(name, "minikube-") {
			return true
		}
		return cluster != nil && strings.Contains(strings.ToLower(cluster.CertificateAuthority), ".minikube")
	default:
		return false
	}
}

func inspectContext(
	ctx context.Context,
	config *clientcmdapi.Config,
	source model.CloudSource,
	providerName string,
	contextName string,
) (model.Cluster, error) {
	overrides := &clientcmd.ConfigOverrides{CurrentContext: contextName}
	clientConfig := clientcmd.NewNonInteractiveClientConfig(*config, contextName, overrides, nil)
	restConfig, err := clientConfig.ClientConfig()
	if err != nil {
		return model.Cluster{}, fmt.Errorf("build client for context %s: %w", contextName, err)
	}
	restConfig.Timeout = 15 * time.Second
	restConfig.QPS = 5
	restConfig.Burst = 10
	restConfig.UserAgent = "kubeops-local-inventory"

	client, err := kubernetes.NewForConfig(restConfig)
	if err != nil {
		return model.Cluster{}, fmt.Errorf("create client for context %s: %w", contextName, err)
	}
	version, err := client.Discovery().ServerVersion()
	if err != nil {
		return model.Cluster{}, fmt.Errorf("query Kubernetes version for context %s: %w", contextName, err)
	}
	nodes, err := client.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return model.Cluster{}, fmt.Errorf("list Kubernetes nodes for context %s: %w", contextName, err)
	}

	var readyNodes int
	for i := range nodes.Items {
		if nodeReady(&nodes.Items[i]) {
			readyNodes++
		}
	}
	status := "active"
	if readyNodes < len(nodes.Items) {
		status = "degraded"
	}
	nodeCount := int32(len(nodes.Items))
	server := restConfig.Host
	location := "local"
	if parsed, parseErr := url.Parse(server); parseErr == nil && parsed.Hostname() != "" {
		location = parsed.Hostname()
	}

	return model.Cluster{
		SourceID:           source.ID,
		Provider:           providerName,
		ProviderResourceID: fmt.Sprintf("kubeconfig:%s:%s", source.ID, contextName),
		Name:               contextName,
		Location:           location,
		KubernetesVersion:  version.GitVersion,
		Status:             status,
		EndpointAccess:     "private",
		NodeCount:          &nodeCount,
		Metadata: map[string]any{
			"context":      contextName,
			"apiServer":    server,
			"readyNodes":   readyNodes,
			"unreadyNodes": len(nodes.Items) - readyNodes,
			"runtime":      providerName,
		},
	}, nil
}

func nodeReady(node *corev1.Node) bool {
	for _, condition := range node.Status.Conditions {
		if condition.Type == corev1.NodeReady {
			return condition.Status == corev1.ConditionTrue
		}
	}
	return false
}

func expandPath(path string) (string, error) {
	if path == "" {
		path = "~/.kube/config"
	}
	if path == "~" || strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolve home directory: %w", err)
		}
		if path == "~" {
			return home, nil
		}
		return filepath.Join(home, strings.TrimPrefix(path, "~/")), nil
	}
	return path, nil
}
