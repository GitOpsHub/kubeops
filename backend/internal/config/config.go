package config

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"strings"
)

type Config struct {
	Environment       string
	Host              string
	Port              string
	CORSAllowedOrigin string
}

func Load(envFile string) (Config, error) {
	if err := loadEnvFile(envFile); err != nil && !errors.Is(err, os.ErrNotExist) {
		return Config{}, err
	}

	return Config{
		Environment:       valueOrDefault("APP_ENV", "development"),
		Host:              valueOrDefault("BACKEND_HOST", "127.0.0.1"),
		Port:              valueOrDefault("BACKEND_PORT", "8080"),
		CORSAllowedOrigin: valueOrDefault("CORS_ALLOWED_ORIGIN", "http://localhost:5173"),
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
