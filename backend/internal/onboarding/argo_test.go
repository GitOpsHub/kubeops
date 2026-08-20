package onboarding

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/GitOpsHub/kubeops/backend/internal/config"
)

func TestHTTPArgoClientStreamsPodLogs(t *testing.T) {
	var requested string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requested = r.URL.RequestURI()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"result":{"content":"ready","last":false}}` + "\n"))
	}))
	defer server.Close()
	client, err := NewHTTPArgoClient(config.ArgoTarget{
		SourceID: "gcp", ServerURL: server.URL, Token: "test-token",
	}, config.OnboardingConfig{RequestTimeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	stream, err := client.PodLogs(
		context.Background(), "nginx", "argo-cd",
		ResourceRef{Version: "v1", Kind: "Pod", Namespace: "dev", Name: "nginx-123"},
	)
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	body, err := io.ReadAll(stream)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `"content":"ready"`) {
		t.Fatalf("unexpected stream: %s", body)
	}
	if requested != "/api/v1/applications/nginx/pods/nginx-123/logs?appNamespace=argo-cd&follow=true&namespace=dev&tailLines=200" {
		t.Fatalf("unexpected request: %s", requested)
	}
}

func TestHTTPArgoClientTreatsForbiddenGetAsMissingApplication(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "permission denied", http.StatusForbidden)
	}))
	defer server.Close()
	client, err := NewHTTPArgoClient(config.ArgoTarget{
		SourceID: "aws", ServerURL: server.URL, Token: "test-token",
	}, config.OnboardingConfig{RequestTimeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}

	_, err = client.GetApplication(context.Background(), "payments", "argo-cd")
	if !errors.Is(err, ErrApplicationNotFound) {
		t.Fatalf("expected missing application, got %v", err)
	}
}

func TestHTTPArgoClientCreatesHelmApplication(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/applications" || r.URL.Query().Get("upsert") != "false" {
			t.Fatalf("unexpected endpoint: %s", r.URL.String())
		}
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Fatal("missing bearer token")
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		spec := body["spec"].(map[string]any)
		sources := spec["sources"].([]any)
		source := sources[0].(map[string]any)
		if source["chart"] != "global-app" || source["targetRevision"] != "1.2.3" {
			t.Fatalf("unexpected source: %#v", source)
		}
		helm := source["helm"].(map[string]any)
		valueFiles := helm["valueFiles"].([]any)
		if valueFiles[0] != "$values/dev/us-east-1/values.yaml" {
			t.Fatalf("unexpected value files: %#v", valueFiles)
		}
		valuesSource := sources[1].(map[string]any)
		if valuesSource["ref"] != "values" ||
			valuesSource["repoURL"] != "https://github.com/GitOpsHub/payments.git" {
			t.Fatalf("unexpected values source: %#v", valuesSource)
		}
		destination := spec["destination"].(map[string]any)
		if destination["server"] != "https://kubernetes.default.svc" {
			t.Fatalf("unexpected destination: %#v", destination)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":{"sync":{"status":"OutOfSync"},"health":{"status":"Progressing"}}}`))
	}))
	defer server.Close()

	client, err := NewHTTPArgoClient(config.ArgoTarget{
		SourceID: "aws", ServerURL: server.URL, Token: "test-token",
	}, config.OnboardingConfig{RequestTimeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	state, err := client.CreateApplication(context.Background(), ApplicationSpec{
		Name: "payments", Namespace: "payments", Project: "default",
		RepoURL: "https://charts.example.test", Chart: "global-app",
		Revision: "1.2.3", ValuesRepoURL: "https://github.com/GitOpsHub/payments.git",
		ValuesRevision: "main", Environment: "dev", Region: "us-east-1",
		ArgoNamespace: "argo-cd",
	})
	if err != nil {
		t.Fatal(err)
	}
	if state.SyncStatus != "OutOfSync" || state.HealthStatus != "Progressing" {
		t.Fatalf("unexpected state: %#v", state)
	}
}

func TestHTTPArgoClientDoesNotExposeResponseBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "token=secret-value", http.StatusBadGateway)
	}))
	defer server.Close()
	client, err := NewHTTPArgoClient(config.ArgoTarget{
		SourceID: "aws", ServerURL: server.URL, Token: "test-token",
	}, config.OnboardingConfig{RequestTimeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.GetApplication(context.Background(), "payments", "argo-cd")
	if err == nil || err.Error() != "Argo CD API returned status 502" {
		t.Fatalf("unexpected safe error: %v", err)
	}
}

func TestHTTPArgoClientSelectsDesiredResourceFromRenderedManifests(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/applications/nginx/manifests" ||
			r.URL.Query().Get("appNamespace") != "argo-cd" {
			t.Fatalf("unexpected endpoint: %s", r.URL.String())
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"manifests": []string{
			`{"apiVersion":"v1","kind":"Service","metadata":{"name":"nginx","namespace":"nginx"}}`,
			`{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"nginx","namespace":"nginx"},"spec":{"replicas":3}}`,
		}})
	}))
	defer server.Close()

	client, err := NewHTTPArgoClient(config.ArgoTarget{
		SourceID: "gcp", ServerURL: server.URL, Token: "test-token",
	}, config.OnboardingConfig{RequestTimeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := client.DesiredResourceManifest(
		context.Background(),
		"nginx",
		"argo-cd",
		ResourceRef{
			Group: "apps", Version: "v1", Kind: "Deployment",
			Namespace: "nginx", Name: "nginx",
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(manifest, `"replicas":3`) {
		t.Fatalf("selected the wrong desired resource: %s", manifest)
	}
}

func TestHTTPArgoClientEnrichesLoadBalancerService(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/applications/nginx/resource-tree":
			_, _ = w.Write([]byte(`{"nodes":[{
				"group":"","version":"v1","kind":"Service","namespace":"nginx",
				"name":"nginx-service","uid":"service-1",
				"health":{"status":"Healthy"}
			}]}`))
		case "/api/v1/applications/nginx":
			_, _ = w.Write([]byte(`{"status":{"resources":[{
				"group":"","version":"v1","kind":"Service","namespace":"nginx",
				"name":"nginx-service","status":"Synced"
			}]}}`))
		case "/api/v1/applications/nginx/resource":
			if r.URL.Query().Get("kind") != "Service" ||
				r.URL.Query().Get("resourceName") != "nginx-service" {
				t.Fatalf("unexpected resource query: %s", r.URL.RawQuery)
			}
			manifest := `apiVersion: v1
kind: Service
spec:
  type: LoadBalancer
  ports:
    - port: 80
      protocol: TCP
status:
  loadBalancer:
    ingress:
      - ip: 35.237.212.233
      - hostname: nginx.example.test
`
			_ = json.NewEncoder(w).Encode(map[string]string{"manifest": manifest})
		default:
			t.Fatalf("unexpected endpoint: %s", r.URL.String())
		}
	}))
	defer server.Close()

	client, err := NewHTTPArgoClient(config.ArgoTarget{
		SourceID: "gcp", ServerURL: server.URL, Token: "test-token",
	}, config.OnboardingConfig{RequestTimeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	nodes, err := client.ApplicationResources(context.Background(), "nginx", "argo-cd")
	if err != nil {
		t.Fatal(err)
	}
	if len(nodes) != 1 || nodes[0].Exposure == nil {
		t.Fatalf("expected one exposed service, got %#v", nodes)
	}
	exposure := nodes[0].Exposure
	if exposure.Type != "LoadBalancer" {
		t.Fatalf("unexpected exposure type: %q", exposure.Type)
	}
	if len(exposure.Addresses) != 2 ||
		exposure.Addresses[0] != "35.237.212.233" ||
		exposure.Addresses[1] != "nginx.example.test" {
		t.Fatalf("unexpected addresses: %#v", exposure.Addresses)
	}
	if len(exposure.Ports) != 1 || exposure.Ports[0] != "80/TCP" {
		t.Fatalf("unexpected ports: %#v", exposure.Ports)
	}
}

// Argo CD hides a missing application behind PermissionDenied on delete just as it
// does on read. Reporting that as a failure would leave an application that is
// already gone permanently stuck at "failed" on every retry.
func TestHTTPArgoClientTreatsForbiddenDeleteAsMissingApplication(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "permission denied", http.StatusForbidden)
	}))
	defer server.Close()

	client, err := NewHTTPArgoClient(config.ArgoTarget{
		SourceID: "aws", ServerURL: server.URL, Token: "test-token",
	}, config.OnboardingConfig{RequestTimeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}

	if err := client.DeleteApplication(
		context.Background(), "payments", "argo-cd",
	); !errors.Is(err, ErrApplicationNotFound) {
		t.Fatalf("expected ErrApplicationNotFound, got %v", err)
	}
}

func TestHTTPArgoClientSyncsAndCascadeDeletesApplication(t *testing.T) {
	var synced, deleted bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Fatal("missing bearer token")
		}
		switch r.Method {
		case http.MethodPost:
			if r.URL.Path != "/api/v1/applications/payments/sync" {
				t.Fatalf("unexpected sync path: %s", r.URL.Path)
			}
			var body struct {
				Name         string `json:"name"`
				AppNamespace string `json:"appNamespace"`
				Prune        bool   `json:"prune"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body.Name != "payments" || body.AppNamespace != "argo-cd" || !body.Prune {
				t.Fatalf("unexpected sync body: %#v", body)
			}
			synced = true
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(
				`{"status":{"sync":{"status":"OutOfSync"},"health":{"status":"Progressing"}}}`,
			))
		case http.MethodDelete:
			if r.URL.Path != "/api/v1/applications/payments" ||
				r.URL.Query().Get("appNamespace") != "argo-cd" ||
				r.URL.Query().Get("cascade") != "true" ||
				r.URL.Query().Get("propagationPolicy") != "foreground" {
				t.Fatalf("unexpected delete request: %s", r.URL.String())
			}
			// Argo CD's grpc-gateway answers 415 to a DELETE that declares no media
			// type, so the header is part of the contract even with no body.
			if r.Header.Get("Content-Type") != "application/json" {
				t.Fatalf("delete declared no media type: %q", r.Header.Get("Content-Type"))
			}
			deleted = true
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Fatalf("unexpected method: %s", r.Method)
		}
	}))
	defer server.Close()

	client, err := NewHTTPArgoClient(config.ArgoTarget{
		SourceID: "aws", ServerURL: server.URL, Token: "test-token",
	}, config.OnboardingConfig{RequestTimeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.SyncApplication(context.Background(), "payments", "argo-cd"); err != nil {
		t.Fatal(err)
	}
	if err := client.DeleteApplication(context.Background(), "payments", "argo-cd"); err != nil {
		t.Fatal(err)
	}
	if !synced || !deleted {
		t.Fatalf("expected sync and delete calls, got synced=%t deleted=%t", synced, deleted)
	}
}

func TestSessionArgoClientLogsInAndAttachesToken(t *testing.T) {
	var sawAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/session" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"token":"session-token-1"}`))
			return
		}
		sawAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":{"sync":{"status":"Synced"},"health":{"status":"Healthy"}}}`))
	}))
	defer server.Close()

	client, err := NewSessionArgoClient(
		context.Background(), server.URL, "admin", "secret",
		config.OnboardingConfig{RequestTimeout: time.Second},
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.GetApplication(context.Background(), "payments", "argo-cd"); err != nil {
		t.Fatal(err)
	}
	if sawAuth != "Bearer session-token-1" {
		t.Fatalf("unexpected Authorization header: %q", sawAuth)
	}
}

// TestSessionArgoClientRelogsInOnUnauthorized proves the kubespin-shaped
// username/password client recovers from an expired or rotated session
// without a cache TTL: it relogs in once when a request comes back 401 and
// retries with the refreshed token.
func TestSessionArgoClientRelogsInOnUnauthorized(t *testing.T) {
	var logins int
	var rejectedOnce bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/session" {
			logins++
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(fmt.Sprintf(`{"token":"session-token-%d"}`, logins)))
			return
		}
		if r.Header.Get("Authorization") == "Bearer session-token-1" && !rejectedOnce {
			rejectedOnce = true
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.Header.Get("Authorization") != "Bearer session-token-2" {
			t.Fatalf("expected the refreshed token, got %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":{"sync":{"status":"Synced"},"health":{"status":"Healthy"}}}`))
	}))
	defer server.Close()

	client, err := NewSessionArgoClient(
		context.Background(), server.URL, "admin", "secret",
		config.OnboardingConfig{RequestTimeout: time.Second},
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.GetApplication(context.Background(), "payments", "argo-cd"); err != nil {
		t.Fatal(err)
	}
	if logins != 2 {
		t.Fatalf("expected an initial login plus one relogin, got %d", logins)
	}
}
