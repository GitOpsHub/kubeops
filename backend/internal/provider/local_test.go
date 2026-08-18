package provider

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/GitOpsHub/kubeops/backend/internal/model"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/version"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

func TestMatchesLocalContext(t *testing.T) {
	tests := []struct {
		provider string
		context  string
		cluster  *clientcmdapi.Cluster
		want     bool
	}{
		{model.ProviderDocker, "docker-desktop", nil, true},
		{model.ProviderDocker, "kind-development", nil, true},
		{model.ProviderDocker, "k3d-lab", nil, true},
		{model.ProviderDocker, "production", nil, false},
		{model.ProviderMinikube, "minikube", nil, true},
		{model.ProviderMinikube, "minikube-team", nil, true},
		{
			model.ProviderMinikube,
			"custom-profile",
			&clientcmdapi.Cluster{CertificateAuthority: "/Users/test/.minikube/ca.crt"},
			true,
		},
	}
	for _, test := range tests {
		if got := matchesLocalContext(test.provider, test.context, test.cluster); got != test.want {
			t.Fatalf("matchesLocalContext(%q, %q) = %t, want %t",
				test.provider, test.context, got, test.want)
		}
	}
}

func TestLocalKubernetesDiscovery(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/version":
			json.NewEncoder(w).Encode(version.Info{
				Major: "1", Minor: "35", GitVersion: "v1.35.1",
			})
		case "/api/v1/nodes":
			json.NewEncoder(w).Encode(corev1.NodeList{
				TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "NodeList"},
				Items: []corev1.Node{
					{
						ObjectMeta: metav1.ObjectMeta{Name: "local-node"},
						Status: corev1.NodeStatus{Conditions: []corev1.NodeCondition{{
							Type: corev1.NodeReady, Status: corev1.ConditionTrue,
						}}},
					},
				},
			})
		default:
			http.NotFound(w, request)
		}
	}))
	defer server.Close()

	kubeconfigPath := filepath.Join(t.TempDir(), "config")
	if err := clientcmd.WriteToFile(clientcmdapi.Config{
		Clusters: map[string]*clientcmdapi.Cluster{
			"docker-desktop": {
				Server: server.URL, InsecureSkipTLSVerify: true,
			},
		},
		AuthInfos: map[string]*clientcmdapi.AuthInfo{
			"docker-desktop": {},
		},
		Contexts: map[string]*clientcmdapi.Context{
			"docker-desktop": {
				Cluster: "docker-desktop", AuthInfo: "docker-desktop",
			},
		},
		CurrentContext: "docker-desktop",
	}, kubeconfigPath); err != nil {
		t.Fatal(err)
	}

	clusters, err := (LocalKubernetes{Provider: model.ProviderDocker}).Discover(
		context.Background(),
		model.CloudSource{
			ID: "docker-local", Provider: model.ProviderDocker, Name: "Docker",
			ScopeID: "local", KubeconfigPath: kubeconfigPath, Enabled: true,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(clusters) != 1 {
		t.Fatalf("expected one cluster, got %#v", clusters)
	}
	cluster := clusters[0]
	if cluster.Name != "docker-desktop" || cluster.KubernetesVersion != "v1.35.1" {
		t.Fatalf("unexpected cluster: %#v", cluster)
	}
	if cluster.NodeCount == nil || *cluster.NodeCount != 1 || cluster.Status != "active" {
		t.Fatalf("unexpected node status: %#v", cluster)
	}
}

// A pinned context that has vanished is a deleted local cluster, not a broken
// setup: discovery reports it absent so the syncer can mark it removed, rather
// than failing and leaving the phantom cluster active forever.
func TestLocalKubernetesDiscoverySkipsDeletedPinnedContexts(t *testing.T) {
	kubeconfigPath := filepath.Join(t.TempDir(), "config")
	if err := clientcmd.WriteToFile(clientcmdapi.Config{
		Clusters:       map[string]*clientcmdapi.Cluster{},
		AuthInfos:      map[string]*clientcmdapi.AuthInfo{},
		Contexts:       map[string]*clientcmdapi.Context{},
		CurrentContext: "",
	}, kubeconfigPath); err != nil {
		t.Fatal(err)
	}

	clusters, err := (LocalKubernetes{Provider: model.ProviderMinikube}).Discover(
		context.Background(),
		model.CloudSource{
			ID: "minikube-local", Provider: model.ProviderMinikube, Name: "Minikube",
			ScopeID: "local", KubeconfigPath: kubeconfigPath, Enabled: true,
			Contexts: []string{"minikube"},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(clusters) != 0 {
		t.Fatalf("expected no clusters for a deleted context, got %#v", clusters)
	}
}
