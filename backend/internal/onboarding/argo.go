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

	"github.com/GitOpsHub/kubeops/backend/internal/config"
)

var (
	ErrApplicationConflict = errors.New("Argo CD application already exists")
	ErrApplicationNotFound = errors.New("Argo CD application not found")
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
	ArgoNamespace  string
}

type ApplicationState struct {
	SyncStatus     string
	HealthStatus   string
	OperationPhase string
	Message        string
}

type ArgoClient interface {
	CreateApplication(context.Context, ApplicationSpec) (ApplicationState, error)
	GetApplication(context.Context, string, string) (ApplicationState, error)
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
						"valueFiles": []string{"$values/values.yaml"},
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
	return c.do(request)
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
		io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return ApplicationState{}, fmt.Errorf("Argo CD API returned status %d", response.StatusCode)
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

func valueOrUnknown(value string) string {
	if value == "" {
		return "Unknown"
	}
	return value
}
