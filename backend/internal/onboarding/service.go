package onboarding

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/GitOpsHub/kubeops/backend/internal/config"
	"github.com/GitOpsHub/kubeops/backend/internal/model"
	"github.com/GitOpsHub/kubeops/backend/internal/secure"
	"gopkg.in/yaml.v3"
)

const maxValuesBytes = 256 * 1024

var dnsLabel = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)

type Repository interface {
	GetClustersByIDs(context.Context, []string) ([]model.Cluster, error)
	CreateApplicationOnboarding(
		context.Context,
		model.ApplicationOnboarding,
		[]model.Cluster,
	) (model.ApplicationOnboarding, error)
	GetApplicationOnboarding(context.Context, string) (model.ApplicationOnboarding, error)
	ListApplicationOnboardings(context.Context, int) ([]model.ApplicationOnboarding, error)
	ListActiveApplicationDeployments(context.Context) ([]model.ApplicationDeployment, error)
	UpdateApplicationDeployment(context.Context, string, string, string, string, string) error
	UpsertArgoAccess(context.Context, model.EncryptedArgoAccess) error
}

type CreateInput struct {
	Name       string   `json:"name"`
	Namespace  string   `json:"namespace"`
	ClusterIDs []string `json:"clusterIds"`
	ValuesYAML string   `json:"valuesYaml"`
}

type Defaults struct {
	ChartRepoURL  string `json:"chartRepoUrl"`
	ChartName     string `json:"chartName"`
	ChartRevision string `json:"chartRevision"`
	ValuesYAML    string `json:"valuesYaml"`
}

type ValidationError struct {
	Message string
}

func (e ValidationError) Error() string { return e.Message }

type ConflictError struct {
	Message string
}

func (e ConflictError) Error() string { return e.Message }

type ExternalError struct {
	Err error
}

func (e ExternalError) Error() string { return e.Err.Error() }
func (e ExternalError) Unwrap() error { return e.Err }

type Service struct {
	store   Repository
	config  config.OnboardingConfig
	clients map[string]ArgoClient
	github  ValuesRepositoryManager
}

func NewService(repository Repository, cfg config.OnboardingConfig) (*Service, error) {
	clients := make(map[string]ArgoClient, len(cfg.ArgoTargets))
	for _, target := range cfg.ArgoTargets {
		client, err := NewHTTPArgoClient(target, cfg)
		if err != nil {
			return nil, err
		}
		clients[targetKey(target.SourceID, target.ProviderResourceID)] = client
	}
	github, err := NewGitHubClient(cfg)
	if err != nil {
		return nil, err
	}
	for _, target := range cfg.ArgoTargets {
		if target.Password == "" {
			continue
		}
		ciphertext, nonce, err := secure.Encrypt(
			cfg.ArgoCredentialKey,
			[]byte(target.Password),
		)
		if err != nil {
			return nil, fmt.Errorf("encrypt Argo CD UI credential: %w", err)
		}
		if err := repository.UpsertArgoAccess(context.Background(), model.EncryptedArgoAccess{
			SourceID:           target.SourceID,
			ProviderResourceID: target.ProviderResourceID,
			URL:                target.UIURL,
			Username:           target.Username,
			PasswordCiphertext: ciphertext,
			PasswordNonce:      nonce,
		}); err != nil {
			return nil, fmt.Errorf("persist Argo CD UI credential: %w", err)
		}
	}
	return &Service{store: repository, config: cfg, clients: clients, github: github}, nil
}

func (s *Service) Create(ctx context.Context, input CreateInput) (model.ApplicationOnboarding, error) {
	input.Name = strings.TrimSpace(input.Name)
	input.Namespace = strings.TrimSpace(input.Namespace)
	if err := s.validateInput(input); err != nil {
		return model.ApplicationOnboarding{}, err
	}

	clusterIDs := uniqueStrings(input.ClusterIDs)
	clusters, err := s.store.GetClustersByIDs(ctx, clusterIDs)
	if err != nil {
		return model.ApplicationOnboarding{}, fmt.Errorf("load target clusters: %w", err)
	}
	if len(clusters) != len(clusterIDs) {
		return model.ApplicationOnboarding{}, ValidationError{Message: "every target cluster must exist"}
	}
	for _, cluster := range clusters {
		if cluster.RemovedAt != nil {
			return model.ApplicationOnboarding{}, ValidationError{Message: "removed clusters cannot receive applications"}
		}
		if _, ok := s.clients[targetKey(cluster.SourceID, cluster.ProviderResourceID)]; !ok {
			return model.ApplicationOnboarding{}, ValidationError{
				Message: fmt.Sprintf("cluster %q does not have an Argo CD target configured", cluster.Name),
			}
		}
	}

	valuesRepository, err := s.github.Provision(ctx, input.Name, input.ValuesYAML)
	if errors.Is(err, ErrRepositoryExists) {
		return model.ApplicationOnboarding{}, ConflictError{
			Message: "a GitHub repository with this application name already exists",
		}
	}
	if err != nil {
		return model.ApplicationOnboarding{}, ExternalError{
			Err: fmt.Errorf("provision GitHub values repository: %w", err),
		}
	}

	digest := sha256.Sum256([]byte(input.ValuesYAML))
	onboarding, err := s.store.CreateApplicationOnboarding(ctx, model.ApplicationOnboarding{
		Name:                 input.Name,
		Namespace:            input.Namespace,
		ChartRepoURL:         s.config.HelmRepoURL,
		ChartName:            s.config.HelmChart,
		ChartRevision:        s.config.HelmRevision,
		ValuesDigest:         "sha256:" + hex.EncodeToString(digest[:]),
		ValuesRepositoryURL:  valuesRepository.URL,
		ValuesRepositoryName: valuesRepository.Name,
		ValuesRevision:       valuesRepository.Revision,
		ValuesCommitSHA:      valuesRepository.CommitSHA,
	}, clusters)
	if err != nil {
		_ = s.github.Delete(context.WithoutCancel(ctx), valuesRepository.Name)
		return model.ApplicationOnboarding{}, fmt.Errorf("store application onboarding: %w", err)
	}

	var wait sync.WaitGroup
	errs := make(chan error, len(onboarding.Targets))
	for _, target := range onboarding.Targets {
		target := target
		wait.Add(1)
		go func() {
			defer wait.Done()
			client := s.clients[targetKey(target.SourceID, target.ProviderResourceID)]
			callCtx, cancel := context.WithTimeout(ctx, s.config.RequestTimeout)
			defer cancel()
			state, createErr := client.CreateApplication(callCtx, ApplicationSpec{
				Name:           input.Name,
				Namespace:      input.Namespace,
				Project:        s.config.ArgoProject,
				RepoURL:        s.config.HelmRepoURL,
				Chart:          s.config.HelmChart,
				Revision:       s.config.HelmRevision,
				ValuesRepoURL:  valuesRepository.CloneURL,
				ValuesRevision: valuesRepository.Revision,
				ArgoNamespace:  s.config.ArgoNamespace,
			})
			status, message := stateToDeployment(state)
			if createErr != nil {
				status = "failed"
				message = safeCreateError(createErr)
			}
			if updateErr := s.store.UpdateApplicationDeployment(
				context.WithoutCancel(ctx),
				target.ID,
				status,
				valueOrUnknown(state.SyncStatus),
				valueOrUnknown(state.HealthStatus),
				message,
			); updateErr != nil {
				errs <- updateErr
			}
		}()
	}
	wait.Wait()
	close(errs)
	if updateErr := <-errs; updateErr != nil {
		return model.ApplicationOnboarding{}, fmt.Errorf("store Argo CD creation result: %w", updateErr)
	}
	return s.store.GetApplicationOnboarding(ctx, onboarding.ID)
}

func (s *Service) Get(ctx context.Context, id string) (model.ApplicationOnboarding, error) {
	return s.store.GetApplicationOnboarding(ctx, id)
}

func (s *Service) List(ctx context.Context, limit int) ([]model.ApplicationOnboarding, error) {
	return s.store.ListApplicationOnboardings(ctx, limit)
}

func (s *Service) Defaults() Defaults {
	return Defaults{
		ChartRepoURL:  s.config.HelmRepoURL,
		ChartName:     s.config.HelmChart,
		ChartRevision: s.config.HelmRevision,
		ValuesYAML:    s.config.HelmDefaultsYAML,
	}
}

func (s *Service) Start(ctx context.Context) {
	go func() {
		s.reconcile(ctx)
		ticker := time.NewTicker(s.config.PollInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.reconcile(ctx)
			}
		}
	}()
}

func (s *Service) reconcile(ctx context.Context) {
	targets, err := s.store.ListActiveApplicationDeployments(ctx)
	if err != nil {
		slog.Error("list active application deployments", "error", err)
		return
	}
	for _, target := range targets {
		if time.Since(target.CreatedAt) >= s.config.DeploymentTimeout {
			if err := s.store.UpdateApplicationDeployment(
				ctx, target.ID, "failed", target.SyncStatus, target.HealthStatus,
				"deployment did not become healthy before the configured timeout",
			); err != nil {
				slog.Error("timeout application deployment", "target", target.ID, "error", err)
			}
			continue
		}
		client, ok := s.clients[targetKey(target.SourceID, target.ProviderResourceID)]
		if !ok {
			if err := s.store.UpdateApplicationDeployment(
				ctx, target.ID, "failed", target.SyncStatus, target.HealthStatus,
				"Argo CD target configuration is no longer available",
			); err != nil {
				slog.Error("fail unconfigured application deployment", "target", target.ID, "error", err)
			}
			continue
		}
		callCtx, cancel := context.WithTimeout(ctx, s.config.RequestTimeout)
		state, getErr := client.GetApplication(callCtx, target.ArgoApplication, s.config.ArgoNamespace)
		cancel()
		status, message := stateToDeployment(state)
		switch {
		case errors.Is(getErr, ErrApplicationNotFound):
			status, message = "failed", "Argo CD application no longer exists"
		case getErr != nil:
			status, message = "progressing", "unable to read application status from Argo CD"
		}
		if err := s.store.UpdateApplicationDeployment(
			ctx, target.ID, status, valueOrUnknown(state.SyncStatus),
			valueOrUnknown(state.HealthStatus), message,
		); err != nil {
			slog.Error("update application deployment status", "target", target.ID, "error", err)
		}
	}
}

func (s *Service) validateInput(input CreateInput) error {
	if s.config.HelmRepoURL == "" || s.config.HelmChart == "" ||
		s.config.HelmRevision == "" || s.config.HelmDefaultsYAML == "" || s.github == nil {
		return ValidationError{Message: "application onboarding is not configured"}
	}
	if !validDNSLabel(input.Name) {
		return ValidationError{Message: "name must be a lowercase DNS label"}
	}
	if !validDNSLabel(input.Namespace) {
		return ValidationError{Message: "namespace must be a lowercase DNS label"}
	}
	if len(input.ClusterIDs) == 0 {
		return ValidationError{Message: "at least one target cluster is required"}
	}
	if len(uniqueStrings(input.ClusterIDs)) != len(input.ClusterIDs) {
		return ValidationError{Message: "target clusters must be unique"}
	}
	if len(input.ValuesYAML) == 0 {
		return ValidationError{Message: "valuesYaml is required"}
	}
	if len(input.ValuesYAML) > maxValuesBytes {
		return ValidationError{Message: "valuesYaml must not exceed 256 KiB"}
	}
	var document yaml.Node
	if err := yaml.Unmarshal([]byte(input.ValuesYAML), &document); err != nil {
		return ValidationError{Message: "valuesYaml must contain valid YAML"}
	}
	if len(document.Content) == 0 || document.Content[0].Kind != yaml.MappingNode {
		return ValidationError{Message: "valuesYaml must contain a top-level mapping"}
	}
	return nil
}

func validDNSLabel(value string) bool {
	return len(value) <= 63 && dnsLabel.MatchString(value)
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func targetKey(sourceID, providerResourceID string) string {
	return sourceID + "\x00" + providerResourceID
}

func stateToDeployment(state ApplicationState) (string, string) {
	if state.OperationPhase == "Failed" || state.OperationPhase == "Error" {
		if state.Message != "" {
			return "failed", state.Message
		}
		return "failed", "Argo CD synchronization failed"
	}
	if state.HealthStatus == "Degraded" {
		if state.Message != "" {
			return "failed", state.Message
		}
		return "failed", "Argo CD reports degraded application health"
	}
	if state.SyncStatus == "Synced" && state.HealthStatus == "Healthy" {
		return "healthy", ""
	}
	return "progressing", state.Message
}

func safeCreateError(err error) string {
	if errors.Is(err, ErrApplicationConflict) {
		return "an Argo CD application with this name already exists"
	}
	return "Argo CD did not accept the application"
}
