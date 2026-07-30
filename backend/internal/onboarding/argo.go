package onboarding

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/GitOpsHub/kubeops/backend/internal/config"
	"gopkg.in/yaml.v3"
)

var (
	ErrApplicationConflict = errors.New("Argo CD application already exists")
	ErrApplicationNotFound = errors.New("Argo CD application not found")
	ErrResourceNotFound    = errors.New("Kubernetes resource not found")
)

type ApplicationSpec struct {
	Name           string
	Namespace      string
	Project        string
	RepoURL        string
	Chart          string
	Revision       string
	ValuesRepoURL  string
	ValuesRevision string
	Environment    string
	Region         string
	ArgoNamespace  string
}

type ApplicationState struct {
	SyncStatus     string
	HealthStatus   string
	OperationPhase string
	Message        string
}

// ResourceRef identifies a single Kubernetes object managed by an application.
// Argo CD addresses resources by this tuple rather than by any opaque id.
type ResourceRef struct {
	Group     string `json:"group"`
	Version   string `json:"version"`
	Kind      string `json:"kind"`
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
}

// ResourceNode is one object in an application's resource tree. ParentUID
// carries the hierarchy (Deployment → ReplicaSet → Pod); an empty ParentUID
// means the node sits at the root.
type ResourceNode struct {
	ResourceRef
	UID          string           `json:"uid"`
	ParentUID    string           `json:"parentUid"`
	HealthStatus string           `json:"healthStatus"`
	SyncStatus   string           `json:"syncStatus"`
	CreatedAt    string           `json:"createdAt"`
	Images       []string         `json:"images,omitempty"`
	Info         []ResourceInfo   `json:"info,omitempty"`
	Exposure     *NetworkExposure `json:"exposure,omitempty"`
}

// ResourceInfo is a label Argo CD attaches to a node, such as a revision or a
// pod's restart count.
type ResourceInfo struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// NetworkExposure describes the cloud entry point attached to a Service or
// Ingress. Argo's resource-tree response omits this live status, so it is
// enriched from the resource manifest for the topology view.
type NetworkExposure struct {
	Type      string   `json:"type"`
	Addresses []string `json:"addresses"`
	Ports     []string `json:"ports,omitempty"`
}

type ArgoClient interface {
	CreateApplication(context.Context, ApplicationSpec) (ApplicationState, error)
	GetApplication(context.Context, string, string) (ApplicationState, error)
	SyncApplication(context.Context, string, string) (ApplicationState, error)
	DeleteApplication(context.Context, string, string) error
	ApplicationResources(context.Context, string, string) ([]ResourceNode, error)
	ResourceManifest(context.Context, string, string, ResourceRef) (string, error)
	DesiredResourceManifest(context.Context, string, string, ResourceRef) (string, error)
	DeleteResource(context.Context, string, string, ResourceRef) error
}

type HTTPArgoClient struct {
	serverURL string
	token     string
	client    *http.Client
}

func NewHTTPArgoClient(target config.ArgoTarget, timeoutConfig config.OnboardingConfig) (*HTTPArgoClient, error) {
	parsed, err := url.Parse(target.ServerURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("invalid Argo CD server URL for %s: %q", target.SourceID, target.ServerURL)
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	if target.CAFile != "" {
		certificate, err := os.ReadFile(target.CAFile)
		if err != nil {
			return nil, fmt.Errorf("read Argo CD CA file: %w", err)
		}
		pool, err := x509.SystemCertPool()
		if err != nil {
			return nil, fmt.Errorf("load system certificate pool: %w", err)
		}
		if !pool.AppendCertsFromPEM(certificate) {
			return nil, errors.New("Argo CD CA file does not contain a valid PEM certificate")
		}
		transport.TLSClientConfig.RootCAs = pool
	}
	return &HTTPArgoClient{
		serverURL: target.ServerURL,
		token:     target.Token,
		client:    &http.Client{Transport: transport, Timeout: timeoutConfig.RequestTimeout},
	}, nil
}

func (c *HTTPArgoClient) CreateApplication(
	ctx context.Context,
	spec ApplicationSpec,
) (ApplicationState, error) {
	valueFiles := []string{"$values/values.yaml"}
	if spec.Environment != "" && spec.Region != "" {
		valueFiles = []string{
			"$values/" + spec.Environment + "/" + spec.Region + "/values.yaml",
		}
	}
	payload := map[string]any{
		"metadata": map[string]any{
			"name":      spec.Name,
			"namespace": spec.ArgoNamespace,
		},
		"spec": map[string]any{
			"project": spec.Project,
			"sources": []any{
				map[string]any{
					"repoURL":        spec.RepoURL,
					"chart":          spec.Chart,
					"targetRevision": spec.Revision,
					"helm": map[string]any{
						"valueFiles": valueFiles,
					},
				},
				map[string]any{
					"repoURL":        spec.ValuesRepoURL,
					"targetRevision": spec.ValuesRevision,
					"ref":            "values",
				},
			},
			"destination": map[string]any{
				"server":    "https://kubernetes.default.svc",
				"namespace": spec.Namespace,
			},
			"syncPolicy": map[string]any{
				"automated": map[string]any{
					"prune":    true,
					"selfHeal": true,
				},
				"syncOptions": []string{"CreateNamespace=true"},
			},
		},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return ApplicationState{}, err
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		c.serverURL+"/api/v1/applications?validate=true&upsert=false",
		bytes.NewReader(body),
	)
	if err != nil {
		return ApplicationState{}, err
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	request.Header.Set("Content-Type", "application/json")
	return c.do(request)
}

func (c *HTTPArgoClient) GetApplication(
	ctx context.Context,
	name, argoNamespace string,
) (ApplicationState, error) {
	endpoint := c.serverURL + "/api/v1/applications/" + url.PathEscape(name) +
		"?appNamespace=" + url.QueryEscape(argoNamespace)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return ApplicationState{}, err
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	state, err := c.do(request)
	var apiErr argoAPIError
	if errors.As(err, &apiErr) && apiErr.status == http.StatusForbidden {
		// Argo CD deliberately returns PermissionDenied instead of NotFound for
		// an absent application to avoid disclosing its existence.
		return ApplicationState{}, ErrApplicationNotFound
	}
	return state, err
}

func (c *HTTPArgoClient) SyncApplication(
	ctx context.Context,
	name, argoNamespace string,
) (ApplicationState, error) {
	body, err := json.Marshal(map[string]any{
		"name":         name,
		"appNamespace": argoNamespace,
		"prune":        true,
	})
	if err != nil {
		return ApplicationState{}, err
	}
	endpoint := c.serverURL + "/api/v1/applications/" + url.PathEscape(name) + "/sync"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return ApplicationState{}, err
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	request.Header.Set("Content-Type", "application/json")
	return c.do(request)
}

func (c *HTTPArgoClient) DeleteApplication(
	ctx context.Context,
	name, argoNamespace string,
) error {
	query := url.Values{
		"appNamespace":      []string{argoNamespace},
		"cascade":           []string{"true"},
		"propagationPolicy": []string{"foreground"},
	}
	endpoint := c.serverURL + "/api/v1/applications/" + url.PathEscape(name) + "?" + query.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodDelete, endpoint, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	// Argo CD's grpc-gateway rejects a DELETE without a media type as 415 even
	// though the request carries no body, which made every offboard fail.
	request.Header.Set("Content-Type", "application/json")
	response, err := c.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	// Argo CD answers PermissionDenied rather than NotFound for an application that
	// is not there, the same way it does for reads. Treating that as missing keeps
	// offboarding idempotent: a target whose application is already gone is
	// offboarded, not failed.
	if response.StatusCode == http.StatusNotFound ||
		response.StatusCode == http.StatusForbidden {
		return ErrApplicationNotFound
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("Argo CD API returned status %d", response.StatusCode)
	}
	return nil
}

// ApplicationResources returns the application's resource tree. Health and
// hierarchy come from the tree endpoint; per-resource sync state lives on the
// application itself, so the two are merged here rather than leaving every row
// showing an unknown sync status.
func (c *HTTPArgoClient) ApplicationResources(
	ctx context.Context,
	name, argoNamespace string,
) ([]ResourceNode, error) {
	query := url.Values{"appNamespace": []string{argoNamespace}}
	endpoint := c.serverURL + "/api/v1/applications/" + url.PathEscape(name) +
		"/resource-tree?" + query.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+c.token)

	var tree struct {
		Nodes []struct {
			ResourceRef
			UID        string `json:"uid"`
			ParentRefs []struct {
				UID string `json:"uid"`
			} `json:"parentRefs"`
			Health struct {
				Status string `json:"status"`
			} `json:"health"`
			CreatedAt string         `json:"createdAt"`
			Images    []string       `json:"images"`
			Info      []ResourceInfo `json:"info"`
		} `json:"nodes"`
	}
	if err := c.decode(request, &tree); err != nil {
		return nil, err
	}

	syncStates, err := c.resourceSyncStates(ctx, name, argoNamespace)
	if err != nil {
		return nil, err
	}

	nodes := make([]ResourceNode, 0, len(tree.Nodes))
	for _, node := range tree.Nodes {
		parent := ""
		if len(node.ParentRefs) > 0 {
			parent = node.ParentRefs[0].UID
		}
		resource := ResourceNode{
			ResourceRef:  node.ResourceRef,
			UID:          node.UID,
			ParentUID:    parent,
			HealthStatus: valueOrUnknown(node.Health.Status),
			// Only resources Argo CD manages directly carry a sync status;
			// generated children such as pods inherit nothing and stay blank.
			SyncStatus: syncStates[refKey(node.ResourceRef)],
			CreatedAt:  node.CreatedAt,
			Images:     node.Images,
			Info:       node.Info,
		}
		if node.Kind == "Service" || node.Kind == "Ingress" {
			manifest, manifestErr := c.ResourceManifest(
				ctx, name, argoNamespace, node.ResourceRef,
			)
			if manifestErr == nil {
				resource.Exposure = networkExposure(node.Kind, manifest)
			}
		}
		nodes = append(nodes, resource)
	}
	return nodes, nil
}

func networkExposure(kind, manifest string) *NetworkExposure {
	var resource struct {
		Spec struct {
			Type  string `yaml:"type"`
			Ports []struct {
				Port     int    `yaml:"port"`
				Protocol string `yaml:"protocol"`
			} `yaml:"ports"`
		} `yaml:"spec"`
		Status struct {
			LoadBalancer struct {
				Ingress []struct {
					IP       string `yaml:"ip"`
					Hostname string `yaml:"hostname"`
				} `yaml:"ingress"`
			} `yaml:"loadBalancer"`
		} `yaml:"status"`
	}
	if err := yaml.Unmarshal([]byte(manifest), &resource); err != nil {
		return nil
	}

	exposureType := kind
	if kind == "Service" {
		if !strings.EqualFold(resource.Spec.Type, "LoadBalancer") {
			return nil
		}
		exposureType = "LoadBalancer"
	}

	exposure := &NetworkExposure{Type: exposureType, Addresses: []string{}}
	seenAddresses := map[string]struct{}{}
	for _, ingress := range resource.Status.LoadBalancer.Ingress {
		address := strings.TrimSpace(ingress.IP)
		if address == "" {
			address = strings.TrimSpace(ingress.Hostname)
		}
		if address == "" {
			continue
		}
		if _, exists := seenAddresses[address]; exists {
			continue
		}
		seenAddresses[address] = struct{}{}
		exposure.Addresses = append(exposure.Addresses, address)
	}
	for _, port := range resource.Spec.Ports {
		protocol := strings.ToUpper(strings.TrimSpace(port.Protocol))
		if protocol == "" {
			protocol = "TCP"
		}
		exposure.Ports = append(exposure.Ports, fmt.Sprintf("%d/%s", port.Port, protocol))
	}
	return exposure
}

func (c *HTTPArgoClient) resourceSyncStates(
	ctx context.Context,
	name, argoNamespace string,
) (map[string]string, error) {
	endpoint := c.serverURL + "/api/v1/applications/" + url.PathEscape(name) +
		"?appNamespace=" + url.QueryEscape(argoNamespace)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+c.token)

	var application struct {
		Status struct {
			Resources []struct {
				ResourceRef
				Status string `json:"status"`
			} `json:"resources"`
		} `json:"status"`
	}
	if err := c.decode(request, &application); err != nil {
		return nil, err
	}
	states := make(map[string]string, len(application.Status.Resources))
	for _, resource := range application.Status.Resources {
		states[refKey(resource.ResourceRef)] = resource.Status
	}
	return states, nil
}

// ResourceManifest returns the live manifest of one resource as YAML.
func (c *HTTPArgoClient) ResourceManifest(
	ctx context.Context,
	name, argoNamespace string,
	ref ResourceRef,
) (string, error) {
	endpoint := c.serverURL + "/api/v1/applications/" + url.PathEscape(name) +
		"/resource?" + resourceQuery(argoNamespace, ref).Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("Authorization", "Bearer "+c.token)

	var payload struct {
		Manifest string `json:"manifest"`
	}
	if err := c.decode(request, &payload); err != nil {
		return "", err
	}
	return payload.Manifest, nil
}

// DesiredResourceManifest returns the Helm-rendered object Argo CD intends to
// apply. The manifests endpoint returns every rendered resource, so select the
// requested object by its Kubernetes identity.
func (c *HTTPArgoClient) DesiredResourceManifest(
	ctx context.Context,
	name, argoNamespace string,
	ref ResourceRef,
) (string, error) {
	endpoint := c.serverURL + "/api/v1/applications/" + url.PathEscape(name) +
		"/manifests?appNamespace=" + url.QueryEscape(argoNamespace)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("Authorization", "Bearer "+c.token)

	var payload struct {
		Manifests []string `json:"manifests"`
	}
	if err := c.decode(request, &payload); err != nil {
		return "", err
	}
	for _, manifest := range payload.Manifests {
		var identity struct {
			APIVersion string `yaml:"apiVersion"`
			Kind       string `yaml:"kind"`
			Metadata   struct {
				Name      string `yaml:"name"`
				Namespace string `yaml:"namespace"`
			} `yaml:"metadata"`
		}
		if err := yaml.Unmarshal([]byte(manifest), &identity); err != nil {
			continue
		}
		group, version := "", identity.APIVersion
		if slash := strings.LastIndex(identity.APIVersion, "/"); slash >= 0 {
			group, version = identity.APIVersion[:slash], identity.APIVersion[slash+1:]
		}
		if identity.Kind == ref.Kind &&
			identity.Metadata.Name == ref.Name &&
			(identity.Metadata.Namespace == "" || identity.Metadata.Namespace == ref.Namespace) &&
			group == ref.Group &&
			version == ref.Version {
			return manifest, nil
		}
	}
	return "", ErrResourceNotFound
}

// DeleteResource removes one resource from the cluster. Argo CD will recreate
// anything still declared in Git on the next sync, so this deletes the live
// object rather than changing what the application should contain.
func (c *HTTPArgoClient) DeleteResource(
	ctx context.Context,
	name, argoNamespace string,
	ref ResourceRef,
) error {
	endpoint := c.serverURL + "/api/v1/applications/" + url.PathEscape(name) +
		"/resource?" + resourceQuery(argoNamespace, ref).Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodDelete, endpoint, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	// The same grpc-gateway media-type requirement that DeleteApplication hits.
	request.Header.Set("Content-Type", "application/json")
	response, err := c.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	if response.StatusCode == http.StatusNotFound ||
		response.StatusCode == http.StatusForbidden {
		return ErrResourceNotFound
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return argoAPIError{status: response.StatusCode}
	}
	return nil
}

func resourceQuery(argoNamespace string, ref ResourceRef) url.Values {
	return url.Values{
		"appNamespace": []string{argoNamespace},
		"namespace":    []string{ref.Namespace},
		"resourceName": []string{ref.Name},
		"version":      []string{ref.Version},
		"kind":         []string{ref.Kind},
		"group":        []string{ref.Group},
	}
}

func refKey(ref ResourceRef) string {
	return ref.Group + "/" + ref.Kind + "/" + ref.Namespace + "/" + ref.Name
}

// decode performs the request and unmarshals a successful response. Error
// bodies are discarded for the same reason do() discards them: they can echo
// credentials back to the caller.
func (c *HTTPArgoClient) decode(request *http.Request, target any) error {
	response, err := c.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound ||
		response.StatusCode == http.StatusForbidden {
		io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return ErrApplicationNotFound
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return argoAPIError{status: response.StatusCode}
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 8<<20)).Decode(target); err != nil {
		return fmt.Errorf("decode Argo CD response: %w", err)
	}
	return nil
}

func (c *HTTPArgoClient) do(request *http.Request) (ApplicationState, error) {
	response, err := c.client.Do(request)
	if err != nil {
		return ApplicationState{}, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusConflict {
		io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return ApplicationState{}, ErrApplicationConflict
	}
	if response.StatusCode == http.StatusNotFound {
		io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return ApplicationState{}, ErrApplicationNotFound
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		// The body is discarded deliberately: it can echo credentials back. See
		// TestHTTPArgoClientDoesNotExposeResponseBody.
		io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return ApplicationState{}, argoAPIError{status: response.StatusCode}
	}
	var application struct {
		Status struct {
			Sync struct {
				Status string `json:"status"`
			} `json:"sync"`
			Health struct {
				Status  string `json:"status"`
				Message string `json:"message"`
			} `json:"health"`
			OperationState struct {
				Phase   string `json:"phase"`
				Message string `json:"message"`
			} `json:"operationState"`
		} `json:"status"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 2<<20)).Decode(&application); err != nil {
		return ApplicationState{}, fmt.Errorf("decode Argo CD response: %w", err)
	}
	message := application.Status.OperationState.Message
	if message == "" {
		message = application.Status.Health.Message
	}
	return ApplicationState{
		SyncStatus:     valueOrUnknown(application.Status.Sync.Status),
		HealthStatus:   valueOrUnknown(application.Status.Health.Status),
		OperationPhase: application.Status.OperationState.Phase,
		Message:        message,
	}, nil
}

type argoAPIError struct {
	status int
}

func (e argoAPIError) Error() string {
	return fmt.Sprintf("Argo CD API returned status %d", e.status)
}

func valueOrUnknown(value string) string {
	if value == "" {
		return "Unknown"
	}
	return value
}
