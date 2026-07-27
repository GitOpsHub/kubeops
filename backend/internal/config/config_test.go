package config

import (
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
