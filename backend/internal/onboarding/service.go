package onboarding

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
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
	ListApplicationOnboardings(
		context.Context,
		model.ApplicationOnboardingFilter,
	) (model.ApplicationOnboardingPage, error)
	ListActiveApplicationDeployments(context.Context) ([]model.ApplicationDeployment, error)
	UpdateApplicationDeployment(context.Context, string, string, string, string, string) error
	UpsertArgoAccess(context.Context, model.EncryptedArgoAccess) error
}

type CreateInput struct {
	Name       string   `json:"name"`
	Namespace  string   `json:"namespace"`
	ClusterIDs []string `json:"clusterIds"`
	ValuesYAML string   `json:"valuesYaml"`
	// RegionValues holds per-region override files keyed by region, layered over
	// ValuesYAML by Argo CD. Regions without an entry deploy the base values alone.
	RegionValues map[string]string `json:"regionValues,omitempty"`
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
	// uiTargets holds only the targets that expose Argo CD UI access, so deep links
	// are omitted for targets reachable by API token alone.
	uiTargets map[string]config.ArgoTarget
	github    ValuesRepositoryManager
}

func NewService(repository Repository, cfg config.OnboardingConfig) (*Service, error) {
	clients := make(map[string]ArgoClient, len(cfg.ArgoTargets))
	uiTargets := make(map[string]config.ArgoTarget, len(cfg.ArgoTargets))
	for _, target := range cfg.ArgoTargets {
		client, err := NewHTTPArgoClient(target, cfg)
		if err != nil {
			return nil, err
		}
		clients[targetKey(target.SourceID, target.ProviderResourceID)] = client
		if target.UIURL != "" && target.Username != "" {
			uiTargets[targetKey(target.SourceID, target.ProviderResourceID)] = target
		}
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
	svc := &Service{store: repository, config: cfg, clients: clients, uiTargets: uiTargets}
	// NewGitHubClient returns a nil *GitHubClient when onboarding is unconfigured.
	// Assign it to the interface field only when non-nil, otherwise the field holds
	// a typed nil that defeats the `s.github == nil` guard in validateInput and
	// panics when Provision is invoked on the nil receiver.
	if github != nil {
		svc.github = github
	}
	return svc, nil
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

	// Only the regions actually covered by the selected clusters are committed, so a
	// stale override left in the form never creates an orphaned directory.
	targetRegions := make(map[string]struct{}, len(clusters))
	for _, cluster := range clusters {
		if cluster.Location != "" {
			targetRegions[cluster.Location] = struct{}{}
		}
	}
	regionValues := make(map[string]string, len(input.RegionValues))
	for region, values := range input.RegionValues {
		if _, ok := targetRegions[region]; !ok {
			continue
		}
		if strings.TrimSpace(values) == "" {
			continue
		}
		regionValues[region] = values
	}

	valuesRepository, err := s.github.Provision(ctx, input.Name, input.ValuesYAML, regionValues)
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
				Region:         regionOverride(regionValues, target.Region),
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
	return s.Get(ctx, onboarding.ID)
}

func (s *Service) Get(ctx context.Context, id string) (model.ApplicationOnboarding, error) {
	record, err := s.store.GetApplicationOnboarding(ctx, id)
	if err != nil {
		return model.ApplicationOnboarding{}, err
	}
	s.enrichTargets(record.Targets)
	return record, nil
}

func (s *Service) List(
	ctx context.Context,
	filter model.ApplicationOnboardingFilter,
) (model.ApplicationOnboardingPage, error) {
	page, err := s.store.ListApplicationOnboardings(ctx, filter)
	if err != nil {
		return model.ApplicationOnboardingPage{}, err
	}
	for i := range page.Items {
		s.enrichTargets(page.Items[i].Targets)
	}
	return page, nil
}

// enrichTargets attaches the Argo CD deep link and username for every target whose
// cluster maps to a configured Argo CD target with UI access.
func (s *Service) enrichTargets(targets []model.ApplicationDeployment) {
	for i := range targets {
		target, ok := s.uiTargets[targetKey(targets[i].SourceID, targets[i].ProviderResourceID)]
		if !ok {
			continue
		}
		targets[i].ArgoApplicationURL = target.UIURL + "/applications/" +
			url.PathEscape(targets[i].ArgoApplication)
		targets[i].ArgoUsername = target.Username
	}
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
	for region, values := range input.RegionValues {
		if strings.TrimSpace(values) == "" {
			continue
		}
		if !validDNSLabel(region) {
			return ValidationError{Message: "region names must be lowercase DNS labels"}
		}
		if len(values) > maxValuesBytes {
			return ValidationError{
				Message: fmt.Sprintf("%s values must not exceed 256 KiB", region),
			}
		}
		var regionDocument yaml.Node
		if err := yaml.Unmarshal([]byte(values), &regionDocument); err != nil {
			return ValidationError{Message: fmt.Sprintf("%s values must contain valid YAML", region)}
		}
		if len(regionDocument.Content) == 0 || regionDocument.Content[0].Kind != yaml.MappingNode {
			return ValidationError{
				Message: fmt.Sprintf("%s values must contain a top-level mapping", region),
			}
		}
	}
	return nil
}

// regionOverride returns the region only when an override file was committed for
// it, so Argo CD is never pointed at a values file that does not exist.
func regionOverride(regionValues map[string]string, region string) string {
	if _, ok := regionValues[region]; ok {
		return region
	}
	return ""
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
