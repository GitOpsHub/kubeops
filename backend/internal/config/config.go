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
	}, nil
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
