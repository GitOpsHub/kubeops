package onboarding

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/GitOpsHub/kubeops/backend/internal/config"
)

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
		source := spec["source"].(map[string]any)
		if source["chart"] != "global-app" || source["targetRevision"] != "1.2.3" {
			t.Fatalf("unexpected source: %#v", source)
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
		Revision: "1.2.3", ValuesYAML: "replicaCount: 1", ArgoNamespace: "argo-cd",
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
