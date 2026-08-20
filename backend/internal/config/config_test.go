package config

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/GitOpsHub/kubeops/backend/internal/cloudauth"
	"github.com/GitOpsHub/kubeops/backend/internal/model"
)

func TestLoadReadsEnvironmentFile(t *testing.T) {
	t.Setenv("APP_ENV", "")
	t.Setenv("BACKEND_HOST", "")
	t.Setenv("BACKEND_PORT", "")
	t.Setenv("PORT", "")
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
	t.Setenv("PORT", "")
	t.Setenv("CORS_ALLOWED_ORIGIN", "")

	cfg, err := Load(filepath.Join(t.TempDir(), "missing"))
	if err != nil {
		t.Fatal(err)
	}

	if cfg.Address() != "127.0.0.1:8080" {
		t.Fatalf("unexpected address: %s", cfg.Address())
	}
}

func TestLoadUsesPlatformPort(t *testing.T) {
	t.Setenv("BACKEND_HOST", "0.0.0.0")
	t.Setenv("BACKEND_PORT", "")
	t.Setenv("PORT", "3000")

	cfg, err := Load(filepath.Join(t.TempDir(), "missing"))
	if err != nil {
		t.Fatal(err)
	}

	if cfg.Address() != "0.0.0.0:3000" {
		t.Fatalf("unexpected address: %s", cfg.Address())
	}
}

func TestLoadUsesInlineCloudSourcesOnVercel(t *testing.T) {
	t.Setenv("VERCEL", "1")
	t.Setenv("BACKGROUND_WORKERS", "")
	t.Setenv("CLOUD_SOURCES_FILE", filepath.Join(t.TempDir(), "missing.yaml"))
	t.Setenv("CLOUD_SOURCES_YAML", `sources:
  - id: gcp-production
    provider: gcp
    name: Production GCP
    scope_id: production-project
    regions: [us-east1]
    enabled: true
`)

	cfg, err := Load(filepath.Join(t.TempDir(), "missing.env"))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.BackgroundWorkers {
		t.Fatal("Vercel should default to request-driven execution")
	}
	if len(cfg.CloudSources) != 1 || cfg.CloudSources[0].ID != "gcp-production" {
		t.Fatalf("unexpected inline cloud sources: %#v", cfg.CloudSources)
	}
}

func TestBackgroundWorkersCanBeExplicitlyEnabled(t *testing.T) {
	t.Setenv("VERCEL", "1")
	t.Setenv("BACKGROUND_WORKERS", "true")
	enabled, err := backgroundWorkersEnabled()
	if err != nil {
		t.Fatal(err)
	}
	if !enabled {
		t.Fatal("expected explicit worker setting to win")
	}
}

func TestLoadPrefersExplicitBackendPort(t *testing.T) {
	t.Setenv("BACKEND_HOST", "0.0.0.0")
	t.Setenv("BACKEND_PORT", "9090")
	t.Setenv("PORT", "3000")

	cfg, err := Load(filepath.Join(t.TempDir(), "missing"))
	if err != nil {
		t.Fatal(err)
	}

	if cfg.Address() != "0.0.0.0:9090" {
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

func TestLoadWritesInlineGoogleCredentials(t *testing.T) {
	t.Setenv("GOOGLE_APPLICATION_CREDENTIALS", "")
	t.Setenv("GOOGLE_APPLICATION_CREDENTIALS_JSON", `{"type":"service_account","project_id":"example"}`)

	if _, err := Load(filepath.Join(t.TempDir(), "missing.env")); err != nil {
		t.Fatal(err)
	}

	path := os.Getenv("GOOGLE_APPLICATION_CREDENTIALS")
	if path == "" {
		t.Fatal("expected GOOGLE_APPLICATION_CREDENTIALS to point at the written document")
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != `{"type":"service_account","project_id":"example"}` {
		t.Fatalf("unexpected credentials content: %s", content)
	}
}

func TestLoadRejectsMalformedGoogleCredentials(t *testing.T) {
	t.Setenv("GOOGLE_APPLICATION_CREDENTIALS", "")
	t.Setenv("GOOGLE_APPLICATION_CREDENTIALS_JSON", "not-json")

	if _, err := Load(filepath.Join(t.TempDir(), "missing.env")); err == nil {
		t.Fatal("expected malformed inline Google credentials to fail")
	}
}

func TestLoadLeavesGoogleCredentialsAloneWhenNoInlineValue(t *testing.T) {
	t.Setenv("GOOGLE_APPLICATION_CREDENTIALS", "/var/run/secrets/gcp.json")
	t.Setenv("GOOGLE_APPLICATION_CREDENTIALS_JSON", "")

	if _, err := Load(filepath.Join(t.TempDir(), "missing.env")); err != nil {
		t.Fatal(err)
	}

	if got := os.Getenv("GOOGLE_APPLICATION_CREDENTIALS"); got != "/var/run/secrets/gcp.json" {
		t.Fatalf("unexpected credentials path: %s", got)
	}
}

func TestLoadCloudIdentityDefaultsToAuto(t *testing.T) {
	t.Setenv("CLOUD_IDENTITY_MODE", "")
	t.Setenv("CLOUD_IDENTITY_AUDIENCE", "https://vercel.com/gitopshub")

	cfg, err := Load(filepath.Join(t.TempDir(), "missing.env"))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CloudIdentity.Mode != cloudauth.ModeAuto {
		t.Fatalf("mode = %q, want auto", cfg.CloudIdentity.Mode)
	}
	if cfg.CloudIdentity.Audience != "https://vercel.com/gitopshub" {
		t.Fatalf("unexpected audience %q", cfg.CloudIdentity.Audience)
	}
}

func TestLoadRejectsUnknownCloudIdentityMode(t *testing.T) {
	t.Setenv("CLOUD_IDENTITY_MODE", "workload")
	if _, err := Load(filepath.Join(t.TempDir(), "missing.env")); err == nil {
		t.Fatal("expected an unknown identity mode to be rejected")
	}
}

func TestParseCloudSourcesRejectsIncompleteFederation(t *testing.T) {
	tests := []struct {
		name    string
		content string
	}{
		{
			name: "gcp provider without impersonation",
			content: `sources:
  - id: gcp-platform
    provider: gcp
    name: GCP
    scope_id: example-project
    workload_identity_provider: //iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/v
`,
		},
		{
			name: "workload identity provider on a non-gcp source",
			content: `sources:
  - id: aws-platform
    provider: aws
    name: AWS
    scope_id: "123456789012"
    workload_identity_provider: //iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/v
`,
		},
		{
			name: "azure client id without a tenant",
			content: `sources:
  - id: azure-platform
    provider: azure
    name: Azure
    scope_id: 00000000-0000-0000-0000-000000000000
    client_id: 11111111-1111-1111-1111-111111111111
`,
		},
		{
			name: "client id on a non-azure source",
			content: `sources:
  - id: gcp-platform
    provider: gcp
    name: GCP
    scope_id: example-project
    client_id: 11111111-1111-1111-1111-111111111111
`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := parseCloudSources([]byte(test.content)); err == nil {
				t.Fatal("expected incomplete federation settings to be rejected")
			}
		})
	}
}

func TestParseCloudSourcesAcceptsFederation(t *testing.T) {
	sources, err := parseCloudSources([]byte(`sources:
  - id: gcp-platform
    provider: gcp
    name: GCP
    scope_id: example-project
    workload_identity_provider: //iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/v
    impersonate_service_account: kubeops@example-project.iam.gserviceaccount.com
  - id: azure-platform
    provider: azure
    name: Azure
    scope_id: 00000000-0000-0000-0000-000000000000
    tenant_id: 00000000-0000-0000-0000-000000000000
    client_id: 11111111-1111-1111-1111-111111111111
`))
	if err != nil {
		t.Fatal(err)
	}
	if sources[0].WorkloadIdentityProvider == "" || sources[1].ClientID == "" {
		t.Fatalf("federation settings were dropped: %#v", sources)
	}
}

func TestFederationModeReportsCredentialPath(t *testing.T) {
	t.Setenv(cloudauth.VercelOIDCTokenEnv, "jwt")
	federating := Config{CloudIdentity: CloudIdentityConfig{Mode: cloudauth.ModeAuto}}

	tests := []struct {
		name   string
		cfg    Config
		source model.CloudSource
		want   string
	}{
		{
			name:   "aws with a role federates",
			cfg:    federating,
			source: model.CloudSource{Provider: model.ProviderAWS, RoleARN: "arn:aws:iam::1:role/KubeOps"},
			want:   "federated",
		},
		{
			name:   "aws without a role falls back",
			cfg:    federating,
			source: model.CloudSource{Provider: model.ProviderAWS},
			want:   "default-chain",
		},
		{
			name:   "azure with a client id federates",
			cfg:    federating,
			source: model.CloudSource{Provider: model.ProviderAzure, ClientID: "client"},
			want:   "federated",
		},
		{
			name:   "off wins over a configured source",
			cfg:    Config{CloudIdentity: CloudIdentityConfig{Mode: cloudauth.ModeOff}},
			source: model.CloudSource{Provider: model.ProviderAWS, RoleARN: "arn:aws:iam::1:role/KubeOps"},
			want:   "default-chain",
		},
		{
			name:   "local providers never federate",
			cfg:    federating,
			source: model.CloudSource{Provider: model.ProviderDocker},
			want:   "default-chain",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := test.cfg.FederationMode(test.source); got != test.want {
				t.Fatalf("FederationMode = %q, want %q", got, test.want)
			}
		})
	}
}

func TestMergeCloudSourcesDatabaseWinsOnConflict(t *testing.T) {
	tests := []struct {
		name string
		yaml []model.CloudSource
		db   []model.CloudSource
		want []model.CloudSource
	}{
		{
			name: "database overrides a yaml source with the same id",
			yaml: []model.CloudSource{
				{ID: "aws-prod", Name: "yaml name", RoleARN: "arn:aws:iam::1:role/old"},
			},
			db: []model.CloudSource{
				{ID: "aws-prod", Name: "db name", RoleARN: "arn:aws:iam::1:role/new"},
			},
			want: []model.CloudSource{
				{ID: "aws-prod", Name: "db name", RoleARN: "arn:aws:iam::1:role/new"},
			},
		},
		{
			name: "yaml-only local dev sources pass through unchanged",
			yaml: []model.CloudSource{
				{ID: "docker-local", Name: "Docker Kubernetes"},
			},
			db: nil,
			want: []model.CloudSource{
				{ID: "docker-local", Name: "Docker Kubernetes"},
			},
		},
		{
			name: "database-only sources are added",
			yaml: []model.CloudSource{
				{ID: "aws-prod", Name: "AWS Production"},
			},
			db: []model.CloudSource{
				{ID: "gcp-dev", Name: "GCP Dev"},
			},
			want: []model.CloudSource{
				{ID: "aws-prod", Name: "AWS Production"},
				{ID: "gcp-dev", Name: "GCP Dev"},
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := MergeCloudSources(test.yaml, test.db)
			if len(got) != len(test.want) {
				t.Fatalf("MergeCloudSources = %#v, want %#v", got, test.want)
			}
			for i := range got {
				if !reflect.DeepEqual(got[i], test.want[i]) {
					t.Fatalf("MergeCloudSources[%d] = %#v, want %#v", i, got[i], test.want[i])
				}
			}
		})
	}
}

func TestMergeArgoTargetsDatabaseWinsOnConflict(t *testing.T) {
	yaml := []ArgoTarget{
		{SourceID: "docker-local", ProviderResourceID: "kubeconfig:docker-local:docker-desktop", ServerURL: "https://localhost:18081"},
		{SourceID: "aws-prod", ProviderResourceID: "arn:aws:eks:us-east-1:1:cluster/old", ServerURL: "https://old.example.com"},
	}
	db := []ArgoTarget{
		{SourceID: "aws-prod", ProviderResourceID: "arn:aws:eks:us-east-1:1:cluster/old", ServerURL: "https://new.example.com"},
		{SourceID: "aws-prod", ProviderResourceID: "arn:aws:eks:us-east-1:1:cluster/eks-spot-dev-02", ServerURL: "https://argocd.example.com"},
	}

	got := MergeArgoTargets(yaml, db)
	if len(got) != 3 {
		t.Fatalf("MergeArgoTargets returned %d targets, want 3: %#v", len(got), got)
	}

	byProxyID := make(map[string]ArgoTarget, len(got))
	for _, target := range got {
		byProxyID[target.ProxyID()] = target
	}

	if target := byProxyID[yaml[0].ProxyID()]; target.ServerURL != "https://localhost:18081" {
		t.Fatalf("yaml-only target changed: %#v", target)
	}
	if target := byProxyID[yaml[1].ProxyID()]; target.ServerURL != "https://new.example.com" {
		t.Fatalf("database target did not win: %#v", target)
	}
	if target := byProxyID[db[1].ProxyID()]; target.ServerURL != "https://argocd.example.com" {
		t.Fatalf("database-only target missing: %#v", target)
	}
}
