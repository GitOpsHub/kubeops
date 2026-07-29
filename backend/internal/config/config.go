package config

import (
	"bufio"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/GitOpsHub/kubeops/backend/internal/model"
	"gopkg.in/yaml.v3"
)

type Config struct {
	Environment       string
	Host              string
	Port              string
	CORSAllowedOrigin string
	DatabaseURL       string
	SyncInterval      time.Duration
	SyncWorkers       int
	CloudSourcesFile  string
	CloudSources      []model.CloudSource
	Onboarding        OnboardingConfig
}

type ArgoTarget struct {
	SourceID           string `yaml:"source_id"`
	ProviderResourceID string `yaml:"provider_resource_id"`
	ServerURL          string `yaml:"server_url"`
	TokenEnv           string `yaml:"token_env"`
	CAFile             string `yaml:"ca_file,omitempty"`
	UIURL              string `yaml:"ui_url,omitempty"`
	Username           string `yaml:"username,omitempty"`
	PasswordEnv        string `yaml:"password_env,omitempty"`
	Token              string `yaml:"-"`
	Password           string `yaml:"-"`
}

// ProxyID is the URL path segment that addresses this target through the Argo CD
// reverse proxy. It is derived rather than configured so the routing key stays
// URL-safe and stable across restarts, and so cluster ARNs and kubeconfig paths
// never appear in browser URLs, history, or access logs.
func (t ArgoTarget) ProxyID() string {
	sum := sha256.Sum256([]byte(t.SourceID + "\x00" + t.ProviderResourceID))
	return hex.EncodeToString(sum[:8])
}

type OnboardingConfig struct {
	HelmRepoURL       string
	HelmChart         string
	HelmRevision      string
	HelmDefaultsFile  string
	HelmDefaultsYAML  string
	ArgoProject       string
	ArgoNamespace     string
	ArgoTargetsFile   string
	ArgoTargets       []ArgoTarget
	ArgoCredentialKey []byte
	GitHubAPIURL      string
	GitHubWebURL      string
	GitHubOrg         string
	GitHubBranch      string
	GitHubToken       string
	GitHubAppID       int64
	GitHubInstallID   int64
	GitHubKeyFile     string
	GitHubVisibility  string
	PollInterval      time.Duration
	DeploymentTimeout time.Duration
	RequestTimeout    time.Duration
	// PublicBaseURL is where a browser reaches this backend. Argo CD deep links are
	// built against it because they are served by the reverse proxy on this origin
	// rather than by the Argo CD server itself.
	PublicBaseURL string
}

func Load(envFile string) (Config, error) {
	if err := loadEnvFile(envFile); err != nil && !errors.Is(err, os.ErrNotExist) {
		return Config{}, err
	}

	syncInterval, err := time.ParseDuration(valueOrDefault("SYNC_INTERVAL", "5m"))
	if err != nil {
		return Config{}, fmt.Errorf("parse SYNC_INTERVAL: %w", err)
	}
	workers, err := strconv.Atoi(valueOrDefault("SYNC_WORKERS", "3"))
	if err != nil || workers < 1 || workers > 20 {
		return Config{}, fmt.Errorf("SYNC_WORKERS must be between 1 and 20")
	}

	sourcesFile := valueOrDefault("CLOUD_SOURCES_FILE", "../config/cloud-sources.yaml")
	sources, err := loadCloudSources(sourcesFile)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return Config{}, err
	}

	onboarding, err := loadOnboardingConfig()
	if err != nil {
		return Config{}, err
	}

	return Config{
		Environment:       valueOrDefault("APP_ENV", "development"),
		Host:              valueOrDefault("BACKEND_HOST", "127.0.0.1"),
		Port:              valueOrDefault("BACKEND_PORT", "8080"),
		CORSAllowedOrigin: valueOrDefault("CORS_ALLOWED_ORIGIN", "http://localhost:5173"),
		DatabaseURL:       valueOrDefault("DATABASE_URL", "postgres://kubeops:kubeops@127.0.0.1:5432/kubeops?sslmode=disable"),
		SyncInterval:      syncInterval,
		SyncWorkers:       workers,
		CloudSourcesFile:  sourcesFile,
		CloudSources:      sources,
		Onboarding:        onboarding,
	}, nil
}

func loadOnboardingConfig() (OnboardingConfig, error) {
	pollInterval, err := time.ParseDuration(valueOrDefault("ARGO_POLL_INTERVAL", "15s"))
	if err != nil || pollInterval <= 0 {
		return OnboardingConfig{}, fmt.Errorf("ARGO_POLL_INTERVAL must be a positive duration")
	}
	deploymentTimeout, err := time.ParseDuration(valueOrDefault("ARGO_DEPLOYMENT_TIMEOUT", "15m"))
	if err != nil || deploymentTimeout <= 0 {
		return OnboardingConfig{}, fmt.Errorf("ARGO_DEPLOYMENT_TIMEOUT must be a positive duration")
	}
	requestTimeout, err := time.ParseDuration(valueOrDefault("ARGO_REQUEST_TIMEOUT", "10s"))
	if err != nil || requestTimeout <= 0 {
		return OnboardingConfig{}, fmt.Errorf("ARGO_REQUEST_TIMEOUT must be a positive duration")
	}

	publicBaseURL := strings.TrimSuffix(valueOrDefault("PUBLIC_BASE_URL", "http://"+
		valueOrDefault("BACKEND_HOST", "127.0.0.1")+":"+
		valueOrDefault("BACKEND_PORT", "8080")), "/")
	if parsed, err := url.Parse(publicBaseURL); err != nil ||
		parsed.Scheme == "" || parsed.Host == "" {
		return OnboardingConfig{}, fmt.Errorf("PUBLIC_BASE_URL must be an absolute URL")
	}

	targetsFile := valueOrDefault("ARGO_TARGETS_FILE", "../config/argo-targets.yaml")
	targets, err := loadArgoTargets(targetsFile)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return OnboardingConfig{}, err
	}
	credentialKey, err := loadArgoCredentialKey(targets)
	if err != nil {
		return OnboardingConfig{}, err
	}
	appID, err := int64Value("GITHUB_APP_ID")
	if err != nil {
		return OnboardingConfig{}, err
	}
	installationID, err := int64Value("GITHUB_APP_INSTALLATION_ID")
	if err != nil {
		return OnboardingConfig{}, err
	}
	defaultsFile := valueOrDefault("GLOBAL_HELM_DEFAULT_VALUES_FILE", "../charts/kubeops/values.yaml")
	defaultsYAML, err := os.ReadFile(defaultsFile)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return OnboardingConfig{}, fmt.Errorf("read global Helm defaults: %w", err)
	}
	visibility := valueOrDefault("GITHUB_REPO_VISIBILITY", "private")
	if visibility != "private" && visibility != "public" {
		return OnboardingConfig{}, fmt.Errorf("GITHUB_REPO_VISIBILITY must be private or public")
	}

	return OnboardingConfig{
		HelmRepoURL:       strings.TrimSpace(os.Getenv("GLOBAL_HELM_REPO_URL")),
		HelmChart:         strings.TrimSpace(os.Getenv("GLOBAL_HELM_CHART")),
		HelmRevision:      strings.TrimSpace(os.Getenv("GLOBAL_HELM_REVISION")),
		HelmDefaultsFile:  defaultsFile,
		HelmDefaultsYAML:  string(defaultsYAML),
		ArgoProject:       valueOrDefault("ARGO_PROJECT", "default"),
		ArgoNamespace:     valueOrDefault("ARGO_NAMESPACE", "argo-cd"),
		ArgoTargetsFile:   targetsFile,
		ArgoTargets:       targets,
		ArgoCredentialKey: credentialKey,
		GitHubAPIURL:      valueOrDefault("GITHUB_API_URL", "https://api.github.com"),
		GitHubWebURL:      strings.TrimSuffix(valueOrDefault("GITHUB_WEB_URL", "https://github.com"), "/"),
		GitHubOrg:         valueOrDefault("GITHUB_ORG", "GitOpsHub"),
		GitHubBranch:      valueOrDefault("GITHUB_DEFAULT_BRANCH", "main"),
		GitHubToken:       strings.TrimSpace(os.Getenv("GITHUB_TOKEN")),
		GitHubAppID:       appID,
		GitHubInstallID:   installationID,
		GitHubKeyFile:     strings.TrimSpace(os.Getenv("GITHUB_APP_PRIVATE_KEY_FILE")),
		GitHubVisibility:  visibility,
		PollInterval:      pollInterval,
		DeploymentTimeout: deploymentTimeout,
		RequestTimeout:    requestTimeout,
		PublicBaseURL:     publicBaseURL,
	}, nil
}

func int64Value(key string) (int64, error) {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return 0, nil
	}
	number, err := strconv.ParseInt(value, 10, 64)
	if err != nil || number <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", key)
	}
	return number, nil
}

func loadArgoTargets(path string) ([]ArgoTarget, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var document struct {
		Targets []ArgoTarget `yaml:"targets"`
	}
	if err := yaml.Unmarshal(content, &document); err != nil {
		return nil, fmt.Errorf("parse Argo targets: %w", err)
	}
	seen := make(map[string]struct{}, len(document.Targets))
	for i := range document.Targets {
		target := &document.Targets[i]
		target.SourceID = strings.TrimSpace(target.SourceID)
		target.ProviderResourceID = strings.TrimSpace(target.ProviderResourceID)
		target.ServerURL = strings.TrimRight(strings.TrimSpace(target.ServerURL), "/")
		target.TokenEnv = strings.TrimSpace(target.TokenEnv)
		target.UIURL = strings.TrimRight(strings.TrimSpace(target.UIURL), "/")
		target.Username = strings.TrimSpace(target.Username)
		target.PasswordEnv = strings.TrimSpace(target.PasswordEnv)
		if target.SourceID == "" || target.ProviderResourceID == "" ||
			target.ServerURL == "" || target.TokenEnv == "" {
			return nil, fmt.Errorf("Argo target %d requires source_id, provider_resource_id, server_url, and token_env", i+1)
		}
		key := target.SourceID + "\x00" + target.ProviderResourceID
		if _, exists := seen[key]; exists {
			return nil, fmt.Errorf("duplicate Argo target for source %q and resource %q", target.SourceID, target.ProviderResourceID)
		}
		seen[key] = struct{}{}
		target.Token = os.Getenv(target.TokenEnv)
		if target.Token == "" {
			return nil, fmt.Errorf("Argo target token environment variable %s is empty", target.TokenEnv)
		}
		hasUIAccess := target.UIURL != "" || target.Username != "" || target.PasswordEnv != ""
		if hasUIAccess {
			parsed, parseErr := url.Parse(target.UIURL)
			if target.UIURL == "" || target.Username == "" || target.PasswordEnv == "" ||
				parseErr != nil || parsed.Scheme != "https" || parsed.Host == "" {
				return nil, fmt.Errorf(
					"Argo target %d UI access requires an HTTPS ui_url, username, and password_env",
					i+1,
				)
			}
			target.Password = os.Getenv(target.PasswordEnv)
			if target.Password == "" {
				return nil, fmt.Errorf(
					"Argo target password environment variable %s is empty",
					target.PasswordEnv,
				)
			}
		}
	}
	return document.Targets, nil
}

func loadArgoCredentialKey(targets []ArgoTarget) ([]byte, error) {
	var needsKey bool
	for _, target := range targets {
		if target.Password != "" {
			needsKey = true
			break
		}
	}
	if !needsKey {
		return nil, nil
	}
	encoded := strings.TrimSpace(os.Getenv("ARGO_CREDENTIAL_ENCRYPTION_KEY"))
	key, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(key) != 32 {
		return nil, errors.New(
			"ARGO_CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
		)
	}
	return key, nil
}

func (c Config) Address() string {
	return c.Host + ":" + c.Port
}

func loadEnvFile(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		key, value, found := strings.Cut(line, "=")
		if !found {
			return fmt.Errorf("invalid environment line %q", line)
		}

		key = strings.TrimSpace(key)
		value = strings.Trim(strings.TrimSpace(value), `"'`)
		if key == "" {
			return fmt.Errorf("environment variable name cannot be empty")
		}
		if current, exists := os.LookupEnv(key); !exists || current == "" {
			if err := os.Setenv(key, value); err != nil {
				return fmt.Errorf("set %s: %w", key, err)
			}
		}
	}

	return scanner.Err()
}

func valueOrDefault(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func loadCloudSources(path string) ([]model.CloudSource, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var document struct {
		Sources []model.CloudSource `yaml:"sources"`
	}
	if err := yaml.Unmarshal(content, &document); err != nil {
		return nil, fmt.Errorf("parse cloud sources: %w", err)
	}

	seen := make(map[string]struct{}, len(document.Sources))
	for i := range document.Sources {
		source := &document.Sources[i]
		source.Provider = strings.ToLower(strings.TrimSpace(source.Provider))
		if source.ID == "" || source.Name == "" || source.ScopeID == "" {
			return nil, fmt.Errorf("cloud source %d requires id, name, and scope_id", i+1)
		}
		if source.Provider != model.ProviderAWS &&
			source.Provider != model.ProviderGCP &&
			source.Provider != model.ProviderAzure &&
			source.Provider != model.ProviderDocker &&
			source.Provider != model.ProviderMinikube {
			return nil, fmt.Errorf("cloud source %q has unsupported provider %q", source.ID, source.Provider)
		}
		if _, exists := seen[source.ID]; exists {
			return nil, fmt.Errorf("duplicate cloud source id %q", source.ID)
		}
		seen[source.ID] = struct{}{}
	}

	return document.Sources, nil
}
