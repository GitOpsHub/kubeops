package config

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadReadsEnvironmentFile(t *testing.T) {
	t.Setenv("APP_ENV", "")
	t.Setenv("BACKEND_HOST", "")
	t.Setenv("BACKEND_PORT", "")
	t.Setenv("CORS_ALLOWED_ORIGIN", "")

	path := filepath.Join(t.TempDir(), ".env")
	content := []byte("APP_ENV=test\nBACKEND_HOST=0.0.0.0\nBACKEND_PORT=9090\nCORS_ALLOWED_ORIGIN=http://example.test\n")
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}

	if cfg.Environment != "test" || cfg.Address() != "0.0.0.0:9090" {
		t.Fatalf("unexpected config: %#v", cfg)
	}
	if cfg.CORSAllowedOrigin != "http://example.test" {
		t.Fatalf("unexpected allowed origin: %s", cfg.CORSAllowedOrigin)
	}
}

func TestLoadUsesDefaultsWhenFileDoesNotExist(t *testing.T) {
	t.Setenv("APP_ENV", "")
	t.Setenv("BACKEND_HOST", "")
	t.Setenv("BACKEND_PORT", "")
	t.Setenv("CORS_ALLOWED_ORIGIN", "")

	cfg, err := Load(filepath.Join(t.TempDir(), "missing"))
	if err != nil {
		t.Fatal(err)
	}

	if cfg.Address() != "127.0.0.1:8080" {
		t.Fatalf("unexpected address: %s", cfg.Address())
	}
}

func TestLoadArgoTargetsResolvesTokenEnvironmentVariable(t *testing.T) {
	t.Setenv("ARGO_PROD_TOKEN", "test-token")
	path := filepath.Join(t.TempDir(), "argo-targets.yaml")
	content := []byte(`targets:
  - source_id: aws-platform
    provider_resource_id: arn:aws:eks:us-east-1:123:cluster/prod
    server_url: https://argo-cd.prod.example.test/
    token_env: ARGO_PROD_TOKEN
`)
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	targets, err := loadArgoTargets(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(targets) != 1 || targets[0].Token != "test-token" ||
		targets[0].ServerURL != "https://argo-cd.prod.example.test" {
		t.Fatalf("unexpected targets: %#v", targets)
	}
}

func TestLoadOnboardingConfigReadsGitHubToken(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "pat-secret")
	t.Setenv("GITHUB_APP_ID", "")
	t.Setenv("GITHUB_APP_INSTALLATION_ID", "")
	t.Setenv("GITHUB_APP_PRIVATE_KEY_FILE", "")
	t.Setenv("ARGO_TARGETS_FILE", filepath.Join(t.TempDir(), "missing-targets.yaml"))

	defaultsPath := filepath.Join(t.TempDir(), "values.yaml")
	if err := os.WriteFile(defaultsPath, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GLOBAL_HELM_DEFAULT_VALUES_FILE", defaultsPath)

	cfg, err := loadOnboardingConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.GitHubToken != "pat-secret" {
		t.Fatal("expected GitHub token from environment")
	}
}

func TestLoadArgoTargetsResolvesUIAccess(t *testing.T) {
	t.Setenv("ARGO_LOCAL_TOKEN", "api-token")
	t.Setenv("ARGO_LOCAL_PASSWORD", "login-password")
	t.Setenv(
		"ARGO_CREDENTIAL_ENCRYPTION_KEY",
		base64.StdEncoding.EncodeToString(make([]byte, 32)),
	)
	path := filepath.Join(t.TempDir(), "argo-targets.yaml")
	content := []byte(`targets:
  - source_id: docker-local
    provider_resource_id: kubeconfig:docker-local:docker-desktop
    server_url: https://localhost:18081
    token_env: ARGO_LOCAL_TOKEN
    ui_url: https://localhost:18081
    username: kubeops
    password_env: ARGO_LOCAL_PASSWORD
`)
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	targets, err := loadArgoTargets(path)
	if err != nil {
		t.Fatal(err)
	}
	key, err := loadArgoCredentialKey(targets)
	if err != nil {
		t.Fatal(err)
	}
	if len(targets) != 1 || targets[0].Password != "login-password" ||
		targets[0].UIURL != "https://localhost:18081" || len(key) != 32 {
		t.Fatalf("unexpected UI access configuration: %#v", targets)
	}
}
