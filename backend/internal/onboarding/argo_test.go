package onboarding

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/GitOpsHub/kubeops/backend/internal/config"
)

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
		if valueFiles[0] != "$values/values.yaml" {
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
		ValuesRevision: "main", ArgoNamespace: "argo-cd",
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
