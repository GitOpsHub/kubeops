package config

import (
	"bufio"
	"errors"
	"fmt"
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
	Token              string `yaml:"-"`
}

type OnboardingConfig struct {
	HelmRepoURL       string
	HelmChart         string
	HelmRevision      string
	ArgoProject       string
	ArgoNamespace     string
	ArgoTargetsFile   string
	ArgoTargets       []ArgoTarget
	PollInterval      time.Duration
	DeploymentTimeout time.Duration
	RequestTimeout    time.Duration
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

	targetsFile := valueOrDefault("ARGO_TARGETS_FILE", "../config/argo-targets.yaml")
	targets, err := loadArgoTargets(targetsFile)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return OnboardingConfig{}, err
	}

	return OnboardingConfig{
		HelmRepoURL:       strings.TrimSpace(os.Getenv("GLOBAL_HELM_REPO_URL")),
		HelmChart:         strings.TrimSpace(os.Getenv("GLOBAL_HELM_CHART")),
		HelmRevision:      strings.TrimSpace(os.Getenv("GLOBAL_HELM_REVISION")),
		ArgoProject:       valueOrDefault("ARGO_PROJECT", "default"),
		ArgoNamespace:     valueOrDefault("ARGO_NAMESPACE", "argo-cd"),
		ArgoTargetsFile:   targetsFile,
		ArgoTargets:       targets,
		PollInterval:      pollInterval,
		DeploymentTimeout: deploymentTimeout,
		RequestTimeout:    requestTimeout,
	}, nil
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
	}
	return document.Targets, nil
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
