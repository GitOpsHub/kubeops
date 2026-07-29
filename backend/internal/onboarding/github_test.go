package onboarding

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/GitOpsHub/kubeops/backend/internal/config"
	"gopkg.in/yaml.v3"
)

func TestNewGitHubClientUsesPATWithoutGitHubApp(t *testing.T) {
	client, err := NewGitHubClient(config.OnboardingConfig{
		GitHubAPIURL:     "https://api.github.test",
		GitHubOrg:        "GitOpsHub",
		GitHubToken:      "pat-secret",
		GitHubVisibility: "private",
		RequestTimeout:   time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	if client == nil {
		t.Fatal("expected PAT-authenticated GitHub client")
	}
	token, err := client.authenticationToken(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if token != "pat-secret" {
		t.Fatal("expected configured PAT")
	}
}

func TestGitHubClientProvisionsValuesRepository(t *testing.T) {
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	var sawValues bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/app/installations/2/access_tokens":
			if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ey") {
				t.Fatal("expected signed app JWT")
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"token": "installation-token", "expires_at": time.Now().Add(time.Hour),
			})
		case r.URL.Path == "/orgs/GitOpsHub/repos":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"name": "payments", "html_url": "https://github.com/GitOpsHub/payments",
				"clone_url":      "https://github.com/GitOpsHub/payments.git",
				"default_branch": "main",
			})
		case r.URL.Path == "/repos/GitOpsHub/payments/contents/dev/us-east-1/values.yaml":
			var body struct {
				Content string `json:"content"`
				Branch  string `json:"branch"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			decoded, err := base64.StdEncoding.DecodeString(body.Content)
			if err != nil || string(decoded) != "replicaCount: 2\n" || body.Branch != "main" {
				t.Fatalf("unexpected values request: %q, %q, %v", decoded, body.Branch, err)
			}
			sawValues = true
			_ = json.NewEncoder(w).Encode(map[string]any{
				"commit": map[string]string{"sha": "commit-1"},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := &GitHubClient{
		apiURL: server.URL, organization: "GitOpsHub", visibility: "private",
		appID: 1, installationID: 2, privateKey: privateKey,
		client: &http.Client{Timeout: time.Second},
	}
	repository, err := client.Ensure(
		context.Background(), "payments", "dev", "replicaCount: 2\n", nil,
		[]string{"us-east-1"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if !sawValues || repository.CommitSHA != "commit-1" ||
		repository.CloneURL != "https://github.com/GitOpsHub/payments.git" {
		t.Fatalf("unexpected repository: %#v", repository)
	}
}

func TestGitHubClientReusesExistingRepositoryValues(t *testing.T) {
	privateKey, _ := rsa.GenerateKey(rand.Reader, 2048)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "access_tokens") {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"token": "installation-token", "expires_at": time.Now().Add(time.Hour),
			})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/orgs/GitOpsHub/repos":
			http.Error(w, "repository exists token=secret-value", http.StatusUnprocessableEntity)
		case r.URL.Path == "/repos/GitOpsHub/payments":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"name": "payments", "html_url": "https://github.com/GitOpsHub/payments",
				"clone_url":      "https://github.com/GitOpsHub/payments.git",
				"default_branch": "main",
			})
		case r.URL.Path == "/repos/GitOpsHub/payments/contents/values.yaml":
			_ = json.NewEncoder(w).Encode(map[string]string{
				"encoding": "base64",
				"content":  base64.StdEncoding.EncodeToString([]byte("replicaCount: 9\n")),
			})
		case r.URL.Path == "/repos/GitOpsHub/payments/commits/main":
			_ = json.NewEncoder(w).Encode(map[string]string{"sha": "existing-commit"})
		case r.URL.Path == "/repos/GitOpsHub/payments/contents/dev/us-east-1/values.yaml":
			_ = json.NewEncoder(w).Encode(map[string]string{
				"encoding": "base64",
				"content":  base64.StdEncoding.EncodeToString([]byte("replicaCount: 9\n")),
			})
		case r.Method == http.MethodPut &&
			r.URL.Path == "/repos/GitOpsHub/payments/contents/dev/eu-west-1/values.yaml":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"commit": map[string]string{"sha": "scoped-commit"},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	client := &GitHubClient{
		apiURL: server.URL, organization: "GitOpsHub", visibility: "private",
		appID: 1, installationID: 2, privateKey: privateKey,
		client: &http.Client{Timeout: time.Second},
	}
	repository, err := client.Ensure(
		context.Background(), "payments", "dev", "replicaCount: 2\n", nil,
		[]string{"us-east-1", "eu-west-1"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if !repository.Existing || repository.ValuesYAML != "replicaCount: 9\n" ||
		repository.CommitSHA != "scoped-commit" || !repository.RegionValues["us-east-1"] ||
		!repository.RegionValues["eu-west-1"] {
		t.Fatalf("unexpected existing repository: %#v", repository)
	}
}

func TestGitHubClientPreservesRepositoryWhenValuesCommitFails(t *testing.T) {
	privateKey, _ := rsa.GenerateKey(rand.Reader, 2048)
	var deleted bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.Contains(r.URL.Path, "access_tokens"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"token": "installation-token", "expires_at": time.Now().Add(time.Hour),
			})
		case r.Method == http.MethodPost:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"name": "payments", "html_url": "url", "clone_url": "clone",
				"default_branch": "main",
			})
		case r.Method == http.MethodDelete:
			deleted = true
			w.WriteHeader(http.StatusNoContent)
		default:
			http.Error(w, "failed", http.StatusInternalServerError)
		}
	}))
	defer server.Close()
	client := &GitHubClient{
		apiURL: server.URL, organization: "GitOpsHub", visibility: "private",
		appID: 1, installationID: 2, privateKey: privateKey,
		client: &http.Client{Timeout: time.Second},
	}
	if _, err := client.Ensure(
		context.Background(), "payments", "dev", "{}\n", nil, []string{"us-east-1"},
	); err == nil {
		t.Fatal("expected values commit failure")
	}
	if deleted {
		t.Fatal("values repository must be preserved after a provisioning failure")
	}
}

func TestMergeValuesYAMLBuildsOneScopedValuesFile(t *testing.T) {
	merged, err := mergeValuesYAML(
		"replicaCount: 2\nimage:\n  repository: nginx\n  tag: stable\n",
		"replicaCount: 4\nimage:\n  tag: qa\n",
	)
	if err != nil {
		t.Fatal(err)
	}
	var values map[string]any
	if err := yaml.Unmarshal([]byte(merged), &values); err != nil {
		t.Fatal(err)
	}
	image, ok := values["image"].(map[string]any)
	if !ok || values["replicaCount"] != 4 ||
		image["repository"] != "nginx" || image["tag"] != "qa" {
		t.Fatalf("unexpected merged values: %#v", values)
	}
}
