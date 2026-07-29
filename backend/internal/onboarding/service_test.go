package onboarding

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/GitOpsHub/kubeops/backend/internal/config"
	"github.com/GitOpsHub/kubeops/backend/internal/model"
	"github.com/GitOpsHub/kubeops/backend/internal/secure"
	"github.com/GitOpsHub/kubeops/backend/internal/store"
)

type fakeRepository struct {
	clusters []model.Cluster
	record   model.ApplicationOnboarding
	active   []model.ApplicationDeployment
	updates  map[string]model.ApplicationDeployment
	access   model.EncryptedArgoAccess
	filter   model.ApplicationOnboardingFilter
	// restarted records the onboardings whose deployment-timeout window was reopened.
	restarted []string
	// existingID is the onboarding already holding the requested name, if any.
	existingID string
	// createErr overrides the result of CreateApplicationOnboarding.
	createErr error
}

func (f *fakeRepository) GetClustersByIDs(context.Context, []string) ([]model.Cluster, error) {
	return f.clusters, nil
}
func (f *fakeRepository) ActiveApplicationOnboardingID(
	context.Context,
	string,
	string,
) (string, error) {
	return f.existingID, nil
}
func (f *fakeRepository) CreateApplicationOnboarding(
	_ context.Context,
	record model.ApplicationOnboarding,
	clusters []model.Cluster,
	regionValues map[string]bool,
) (model.ApplicationOnboarding, error) {
	if f.createErr != nil {
		return model.ApplicationOnboarding{}, f.createErr
	}
	record.ID = "onboarding-1"
	record.Status = "progressing"
	record.CreatedAt = time.Now()
	for index, cluster := range clusters {
		record.Targets = append(record.Targets, model.ApplicationDeployment{
			ID: "target-" + string(rune('1'+index)), OnboardingID: record.ID,
			ClusterID: cluster.ID, ClusterName: cluster.Name, Region: cluster.Location,
			SourceID:           cluster.SourceID,
			ProviderResourceID: cluster.ProviderResourceID, ArgoApplication: record.Name,
			HasRegionValues: regionValues[cluster.Location],
			Status:          "creating", SyncStatus: "Unknown", HealthStatus: "Unknown",
			CreatedAt: time.Now(),
		})
	}
	f.record = record
	return record, nil
}
func (f *fakeRepository) GetApplicationOnboarding(
	context.Context,
	string,
) (model.ApplicationOnboarding, error) {
	for index := range f.record.Targets {
		if update, ok := f.updates[f.record.Targets[index].ID]; ok {
			f.record.Targets[index] = update
		}
	}
	return f.record, nil
}
func (f *fakeRepository) ListApplicationOnboardings(
	_ context.Context,
	filter model.ApplicationOnboardingFilter,
) (model.ApplicationOnboardingPage, error) {
	f.filter = filter
	return model.ApplicationOnboardingPage{
		Items: []model.ApplicationOnboarding{f.record},
		Total: 1, Page: filter.Page, PageSize: filter.PageSize,
	}, nil
}
func (f *fakeRepository) ListActiveApplicationDeployments(
	context.Context,
) ([]model.ApplicationDeployment, error) {
	return f.active, nil
}
func (f *fakeRepository) UpdateApplicationDeployment(
	_ context.Context,
	id, status, syncStatus, healthStatus, message string,
) error {
	if f.updates == nil {
		f.updates = make(map[string]model.ApplicationDeployment)
	}
	target := f.updates[id]
	target.ID = id
	target.Status = status
	target.SyncStatus = syncStatus
	target.HealthStatus = healthStatus
	target.Message = message
	f.updates[id] = target
	return nil
}
func (f *fakeRepository) RestartApplicationDeploymentAttempts(
	_ context.Context,
	onboardingID string,
) error {
	f.restarted = append(f.restarted, onboardingID)
	for index := range f.active {
		f.active[index].AttemptStartedAt = time.Now()
	}
	return nil
}
func (f *fakeRepository) UpsertArgoAccess(
	_ context.Context,
	access model.EncryptedArgoAccess,
) error {
	f.access = access
	return nil
}

type fakeArgoClient struct {
	created   ApplicationSpec
	synced    string
	deleted   string
	state     ApplicationState
	err       error
	createErr error
	getErr    error
	syncErr   error
	deleteErr error
	// Resource-tree responses and the ref the last delete was asked for.
	resources       []ResourceNode
	manifest        string
	resourceErr     error
	deletedResource ResourceRef
}

type fakeValuesRepositoryManager struct {
	repository ValuesRepository
	err        error
	deleted    string
	regions    map[string]string
	// calls counts Ensure invocations, so a refused onboarding can be shown to
	// have left no repository behind.
	calls int
}

func (f *fakeValuesRepositoryManager) Ensure(
	_ context.Context,
	_ string,
	baseValues string,
	regionValues map[string]string,
	_ []string,
) (ValuesRepository, error) {
	f.calls++
	f.regions = regionValues
	if f.repository.ValuesYAML == "" {
		f.repository.ValuesYAML = baseValues
	}
	if f.repository.RegionValues == nil {
		f.repository.RegionValues = regionKeys(regionValues)
	}
	return f.repository, f.err
}

func (f *fakeArgoClient) CreateApplication(
	_ context.Context,
	spec ApplicationSpec,
) (ApplicationState, error) {
	f.created = spec
	if f.createErr != nil {
		return f.state, f.createErr
	}
	return f.state, f.err
}
func (f *fakeArgoClient) GetApplication(
	context.Context,
	string,
	string,
) (ApplicationState, error) {
	if f.getErr != nil {
		return f.state, f.getErr
	}
	return f.state, f.err
}
func (f *fakeArgoClient) SyncApplication(
	_ context.Context,
	name, _ string,
) (ApplicationState, error) {
	f.synced = name
	if f.syncErr != nil {
		return f.state, f.syncErr
	}
	return f.state, f.err
}
func (f *fakeArgoClient) DeleteApplication(
	_ context.Context,
	name, _ string,
) error {
	f.deleted = name
	if f.deleteErr != nil {
		return f.deleteErr
	}
	return f.err
}
func (f *fakeArgoClient) ApplicationResources(
	_ context.Context,
	_, _ string,
) ([]ResourceNode, error) {
	return f.resources, f.resourceErr
}
func (f *fakeArgoClient) ResourceManifest(
	_ context.Context,
	_, _ string,
	_ ResourceRef,
) (string, error) {
	return f.manifest, f.resourceErr
}
func (f *fakeArgoClient) DeleteResource(
	_ context.Context,
	_, _ string,
	ref ResourceRef,
) error {
	f.deletedResource = ref
	return f.resourceErr
}

func TestCreateApplicationOnboarding(t *testing.T) {
	cluster := model.Cluster{
		ID: "cluster-1", Name: "prod", SourceID: "aws",
		ProviderResourceID: "arn:cluster/prod",
	}
	repository := &fakeRepository{clusters: []model.Cluster{cluster}}
	client := &fakeArgoClient{state: ApplicationState{
		SyncStatus: "OutOfSync", HealthStatus: "Progressing",
	}}
	valuesManager := &fakeValuesRepositoryManager{repository: ValuesRepository{
		Name: "payments", URL: "https://github.com/GitOpsHub/payments",
		CloneURL: "https://github.com/GitOpsHub/payments.git",
		Revision: "main", CommitSHA: "commit-1",
	}}
	service := &Service{
		store: repository,
		config: config.OnboardingConfig{
			HelmRepoURL: "https://charts.example.test", HelmChart: "global-app",
			HelmRevision: "1.2.3", ArgoProject: "platform", ArgoNamespace: "argo-cd",
			RequestTimeout: time.Second, HelmDefaultsYAML: "replicaCount: 2\n",
		},
		clients: map[string]ArgoClient{targetKey("aws", "arn:cluster/prod"): client},
		github:  valuesManager,
	}

	record, err := service.Create(context.Background(), CreateInput{
		Name: "payments", Namespace: "payments", ClusterIDs: []string{"cluster-1"},
		ValuesYAML: "replicaCount: 2\n",
	})
	if err != nil {
		t.Fatal(err)
	}
	if client.created.Chart != "global-app" || client.created.Project != "platform" {
		t.Fatalf("unexpected application spec: %#v", client.created)
	}
	if record.ValuesDigest == "" || record.Targets[0].Status != "progressing" {
		t.Fatalf("unexpected record: %#v", record)
	}
	if record.Environment != "dev" {
		t.Fatalf("expected default environment, got %q", record.Environment)
	}
	if record.Region != "us-east-1" {
		t.Fatalf("expected default application region, got %#v", record)
	}
	if client.created.ValuesRepoURL != valuesManager.repository.CloneURL ||
		record.ValuesRepositoryURL != valuesManager.repository.URL {
		t.Fatalf("unexpected values repository: %#v, %#v", client.created, record)
	}
}

// A second onboarding of the same name would claim the Argo CD application the
// first one already owns, so it is refused before any GitHub or Argo CD work.
func TestCreateApplicationOnboardingRejectsDuplicateName(t *testing.T) {
	cluster := model.Cluster{
		ID: "cluster-1", Name: "prod", SourceID: "aws",
		ProviderResourceID: "arn:cluster/prod",
	}
	repository := &fakeRepository{
		clusters:   []model.Cluster{cluster},
		existingID: "onboarding-1",
	}
	client := &fakeArgoClient{}
	valuesManager := &fakeValuesRepositoryManager{}
	service := &Service{
		store: repository,
		config: config.OnboardingConfig{
			HelmRepoURL: "https://charts.example.test", HelmChart: "global-app",
			HelmRevision: "1.2.3", ArgoProject: "platform", ArgoNamespace: "argo-cd",
			RequestTimeout: time.Second, HelmDefaultsYAML: "replicaCount: 2\n",
		},
		clients: map[string]ArgoClient{targetKey("aws", "arn:cluster/prod"): client},
		github:  valuesManager,
	}

	_, err := service.Create(context.Background(), CreateInput{
		Name: "payments", Namespace: "payments", ClusterIDs: []string{"cluster-1"},
		ValuesYAML: "replicaCount: 2\n",
	})

	var conflict ConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("expected a conflict, got %v", err)
	}
	if valuesManager.calls != 0 {
		t.Fatalf("GitHub was touched %d times for a refused onboarding", valuesManager.calls)
	}
	if client.created.Name != "" {
		t.Fatalf("Argo CD was asked to create %q for a refused onboarding", client.created.Name)
	}
}

// The unique index is the real guard: two requests can pass the lookup at once.
func TestCreateApplicationOnboardingReportsRacedDuplicate(t *testing.T) {
	cluster := model.Cluster{
		ID: "cluster-1", Name: "prod", SourceID: "aws",
		ProviderResourceID: "arn:cluster/prod",
	}
	repository := &fakeRepository{
		clusters:  []model.Cluster{cluster},
		createErr: store.ErrOnboardingExists,
	}
	service := &Service{
		store: repository,
		config: config.OnboardingConfig{
			HelmRepoURL: "https://charts.example.test", HelmChart: "global-app",
			HelmRevision: "1.2.3", ArgoProject: "platform", ArgoNamespace: "argo-cd",
			RequestTimeout: time.Second, HelmDefaultsYAML: "replicaCount: 2\n",
		},
		clients: map[string]ArgoClient{
			targetKey("aws", "arn:cluster/prod"): &fakeArgoClient{},
		},
		github: &fakeValuesRepositoryManager{},
	}

	_, err := service.Create(context.Background(), CreateInput{
		Name: "payments", Namespace: "payments", ClusterIDs: []string{"cluster-1"},
		ValuesYAML: "replicaCount: 2\n",
	})

	var conflict ConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("expected a conflict, got %v", err)
	}
}

func TestCreateApplicationOnboardingLayersRegionValues(t *testing.T) {
	east := model.Cluster{
		ID: "cluster-1", Name: "prod-east", SourceID: "aws",
		ProviderResourceID: "arn:cluster/east", Location: "us-east-1",
	}
	west := model.Cluster{
		ID: "cluster-2", Name: "prod-west", SourceID: "aws",
		ProviderResourceID: "arn:cluster/west", Location: "eu-west-1",
	}
	repository := &fakeRepository{clusters: []model.Cluster{east, west}}
	state := ApplicationState{SyncStatus: "OutOfSync", HealthStatus: "Progressing"}
	eastClient := &fakeArgoClient{state: state}
	westClient := &fakeArgoClient{state: state}
	valuesManager := &fakeValuesRepositoryManager{repository: ValuesRepository{
		Name: "payments", CloneURL: "https://github.com/GitOpsHub/payments.git",
		Revision: "main",
	}}
	service := &Service{
		store: repository,
		config: config.OnboardingConfig{
			HelmRepoURL: "https://charts.example.test", HelmChart: "global-app",
			HelmRevision: "1.2.3", ArgoProject: "platform", ArgoNamespace: "argo-cd",
			RequestTimeout: time.Second, HelmDefaultsYAML: "replicaCount: 2\n",
		},
		clients: map[string]ArgoClient{
			targetKey("aws", "arn:cluster/east"): eastClient,
			targetKey("aws", "arn:cluster/west"): westClient,
		},
		github: valuesManager,
	}

	_, err := service.Create(context.Background(), CreateInput{
		Name: "payments", Namespace: "payments",
		ClusterIDs: []string{"cluster-1", "cluster-2"},
		ValuesYAML: "replicaCount: 2\n",
		RegionValues: map[string]string{
			"us-east-1": "replicaCount: 5\n",
			// Blank and untargeted regions must never reach the values repository.
			"eu-west-1":  "   ",
			"ap-south-1": "replicaCount: 9\n",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(valuesManager.regions) != 1 || valuesManager.regions["us-east-1"] != "replicaCount: 5\n" {
		t.Fatalf("unexpected committed region values: %#v", valuesManager.regions)
	}
	// Only the region with a committed override may be layered by Argo CD.
	if eastClient.created.Region != "us-east-1" {
		t.Fatalf("expected us-east-1 override, got %q", eastClient.created.Region)
	}
	if westClient.created.Region != "" {
		t.Fatalf("expected no override for eu-west-1, got %q", westClient.created.Region)
	}
}

func TestCreateApplicationOnboardingReusesGitHubValues(t *testing.T) {
	cluster := model.Cluster{
		ID: "cluster-1", Name: "prod", SourceID: "aws",
		ProviderResourceID: "arn:cluster/prod",
	}
	repository := &fakeRepository{clusters: []model.Cluster{cluster}}
	client := &fakeArgoClient{}
	existingValues := "replicaCount: 9\n"
	valuesManager := &fakeValuesRepositoryManager{repository: ValuesRepository{
		Name: "payments", URL: "https://github.com/GitOpsHub/payments",
		CloneURL: "https://github.com/GitOpsHub/payments.git",
		Revision: "main", CommitSHA: "existing-commit",
		ValuesYAML: existingValues, Existing: true,
	}}
	service := &Service{
		store: repository,
		config: config.OnboardingConfig{
			HelmRepoURL: "repo", HelmChart: "chart", HelmRevision: "1",
			ArgoProject: "default", ArgoNamespace: "argo-cd",
			RequestTimeout: time.Second, HelmDefaultsYAML: "{}\n",
		},
		clients: map[string]ArgoClient{targetKey("aws", "arn:cluster/prod"): client},
		github:  valuesManager,
	}

	record, err := service.Create(context.Background(), CreateInput{
		Name: "payments", Namespace: "payments", ClusterIDs: []string{"cluster-1"},
		ValuesYAML: "replicaCount: 2\n",
	})
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(existingValues))
	if record.ValuesDigest != "sha256:"+hex.EncodeToString(digest[:]) ||
		record.ValuesCommitSHA != "existing-commit" ||
		record.ValuesRepositoryCloneURL != valuesManager.repository.CloneURL {
		t.Fatalf("existing repository metadata was not persisted: %#v", record)
	}
}

func TestSyncRecreatesMissingApplicationAndSynchronizesIt(t *testing.T) {
	target := model.ApplicationDeployment{
		ID: "target-1", ClusterName: "prod", SourceID: "aws",
		ProviderResourceID: "arn:cluster/prod", ArgoApplication: "payments",
		Status: "failed", SyncStatus: "Unknown", HealthStatus: "Unknown",
	}
	repository := &fakeRepository{record: model.ApplicationOnboarding{
		ID: "onboarding-1", Name: "payments", Namespace: "payments",
		ChartRepoURL: "repo", ChartName: "chart", ChartRevision: "1",
		ValuesRepositoryURL:      "https://github.com/GitOpsHub/payments",
		ValuesRepositoryCloneURL: "https://github.com/GitOpsHub/payments.git",
		ValuesRevision:           "main", Targets: []model.ApplicationDeployment{target},
	}}
	client := &fakeArgoClient{
		state: ApplicationState{SyncStatus: "Synced", HealthStatus: "Healthy"},
	}
	service := &Service{
		store: repository,
		config: config.OnboardingConfig{
			ArgoProject: "default", ArgoNamespace: "argo-cd", RequestTimeout: time.Second,
		},
		clients: map[string]ArgoClient{targetKey("aws", "arn:cluster/prod"): client},
	}

	if _, err := service.Sync(context.Background(), "onboarding-1"); err != nil {
		t.Fatal(err)
	}
	if client.created.Name != "payments" || client.synced != "payments" ||
		repository.updates[target.ID].Status != "healthy" {
		t.Fatalf("application was not recreated and synced: client=%#v update=%#v",
			client, repository.updates[target.ID])
	}
}

func TestOffboardDeletesApplicationButPreservesRepositoryRecord(t *testing.T) {
	target := model.ApplicationDeployment{
		ID: "target-1", ClusterName: "prod", SourceID: "aws",
		ProviderResourceID: "arn:cluster/prod", ArgoApplication: "payments",
		Status: "healthy", SyncStatus: "Synced", HealthStatus: "Healthy",
	}
	repository := &fakeRepository{record: model.ApplicationOnboarding{
		ID: "onboarding-1", Name: "payments",
		ValuesRepositoryURL: "https://github.com/GitOpsHub/payments",
		Targets:             []model.ApplicationDeployment{target},
	}}
	client := &fakeArgoClient{}
	service := &Service{
		store: repository,
		config: config.OnboardingConfig{
			ArgoNamespace: "argo-cd", RequestTimeout: time.Second,
		},
		clients: map[string]ArgoClient{targetKey("aws", "arn:cluster/prod"): client},
	}

	record, err := service.Offboard(context.Background(), "onboarding-1")
	if err != nil {
		t.Fatal(err)
	}
	if client.deleted != "payments" ||
		repository.updates[target.ID].Status != "offboarded" ||
		record.ValuesRepositoryURL != "https://github.com/GitOpsHub/payments" {
		t.Fatalf("unexpected offboard result: client=%#v record=%#v update=%#v",
			client, record, repository.updates[target.ID])
	}
}

func TestNewServiceEncryptsArgoUIAccess(t *testing.T) {
	repository := &fakeRepository{}
	key := bytes.Repeat([]byte{3}, secure.KeyBytes)
	_, err := NewService(repository, config.OnboardingConfig{
		ArgoCredentialKey: key,
		RequestTimeout:    time.Second,
		ArgoTargets: []config.ArgoTarget{{
			SourceID: "docker-local", ProviderResourceID: "docker-desktop",
			ServerURL: "https://localhost:18081", Token: "api-token",
			UIURL: "https://localhost:18081", Username: "kubeops",
			Password: "login-password",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(repository.access.PasswordCiphertext, []byte("login-password")) {
		t.Fatal("stored Argo CD credential exposed plaintext")
	}
	password, err := secure.Decrypt(
		key,
		repository.access.PasswordCiphertext,
		repository.access.PasswordNonce,
	)
	if err != nil || string(password) != "login-password" {
		t.Fatalf("unexpected stored credential: %q, %v", password, err)
	}
}

func TestCreateApplicationOnboardingValidation(t *testing.T) {
	service := &Service{config: config.OnboardingConfig{
		HelmRepoURL: "repo", HelmChart: "chart", HelmRevision: "1",
		HelmDefaultsYAML: "{}\n",
	}, github: &fakeValuesRepositoryManager{}}
	tests := []CreateInput{
		{Name: "Bad_Name", Namespace: "apps", ClusterIDs: []string{"one"}, ValuesYAML: "{}"},
		{Name: "app", Namespace: "apps", Environment: "Bad Env", ClusterIDs: []string{"one"}, ValuesYAML: "{}"},
		{Name: "app", Namespace: "apps", Environment: "stage", ClusterIDs: []string{"one"}, ValuesYAML: "{}"},
		{Name: "app", Namespace: "apps", Region: "us-west-1", ClusterIDs: []string{"one"}, ValuesYAML: "{}"},
		{Name: "app", Namespace: "apps", ClusterIDs: nil, ValuesYAML: "{}"},
		{Name: "app", Namespace: "apps", ClusterIDs: []string{"one"}, ValuesYAML: "- item"},
		{Name: "app", Namespace: "apps", ClusterIDs: []string{"one"}, ValuesYAML: "broken: ["},
	}
	for _, input := range tests {
		if err := service.validateInput(input); err == nil {
			t.Fatalf("expected validation failure for %#v", input)
		}
	}
}

func TestReconcileMarksSyncedHealthyApplicationHealthy(t *testing.T) {
	target := model.ApplicationDeployment{
		ID: "target-1", SourceID: "aws", ProviderResourceID: "arn:cluster/prod",
		ArgoApplication: "payments", CreatedAt: time.Now(),
		AttemptStartedAt: time.Now(),
	}
	repository := &fakeRepository{active: []model.ApplicationDeployment{target}}
	client := &fakeArgoClient{state: ApplicationState{
		SyncStatus: "Synced", HealthStatus: "Healthy",
	}}
	service := &Service{
		store: repository,
		config: config.OnboardingConfig{
			ArgoNamespace: "argo-cd", RequestTimeout: time.Second,
			DeploymentTimeout: 15 * time.Minute,
		},
		clients: map[string]ArgoClient{targetKey("aws", "arn:cluster/prod"): client},
	}

	service.reconcile(context.Background())

	if repository.updates[target.ID].Status != "healthy" {
		t.Fatalf("unexpected update: %#v", repository.updates[target.ID])
	}
}

// A target onboarded long ago and re-synced moments ago must be judged on the
// current attempt. Measuring the timeout from CreatedAt failed every target of an
// onboarding older than the timeout before Argo CD was ever read, so no amount of
// re-syncing could bring it back to healthy.
func TestReconcileTimesOutOnAttemptNotTargetAge(t *testing.T) {
	target := model.ApplicationDeployment{
		ID: "target-1", SourceID: "aws", ProviderResourceID: "arn:cluster/prod",
		ArgoApplication: "payments", Status: "progressing",
		CreatedAt:        time.Now().Add(-48 * time.Hour),
		AttemptStartedAt: time.Now(),
	}
	repository := &fakeRepository{active: []model.ApplicationDeployment{target}}
	client := &fakeArgoClient{state: ApplicationState{
		SyncStatus: "Synced", HealthStatus: "Healthy",
	}}
	service := &Service{
		store: repository,
		config: config.OnboardingConfig{
			ArgoNamespace: "argo-cd", RequestTimeout: time.Second,
			DeploymentTimeout: 15 * time.Minute,
		},
		clients: map[string]ArgoClient{targetKey("aws", "arn:cluster/prod"): client},
	}

	service.reconcile(context.Background())

	if update := repository.updates[target.ID]; update.Status != "healthy" {
		t.Fatalf("stale target age timed out a fresh attempt: %#v", update)
	}
}

// The timeout must still fire once the current attempt itself exhausts it.
func TestReconcileTimesOutExhaustedAttempt(t *testing.T) {
	target := model.ApplicationDeployment{
		ID: "target-1", SourceID: "aws", ProviderResourceID: "arn:cluster/prod",
		ArgoApplication: "payments", Status: "progressing",
		CreatedAt:        time.Now().Add(-48 * time.Hour),
		AttemptStartedAt: time.Now().Add(-30 * time.Minute),
	}
	repository := &fakeRepository{active: []model.ApplicationDeployment{target}}
	client := &fakeArgoClient{state: ApplicationState{
		SyncStatus: "Synced", HealthStatus: "Healthy",
	}}
	service := &Service{
		store: repository,
		config: config.OnboardingConfig{
			ArgoNamespace: "argo-cd", RequestTimeout: time.Second,
			DeploymentTimeout: 15 * time.Minute,
		},
		clients: map[string]ArgoClient{targetKey("aws", "arn:cluster/prod"): client},
	}

	service.reconcile(context.Background())

	update := repository.updates[target.ID]
	if update.Status != "failed" ||
		update.Message != "deployment did not become healthy before the configured timeout" {
		t.Fatalf("exhausted attempt was not timed out: %#v", update)
	}
}

// A dead port-forward reported as "did not accept the application" sends
// operators to the manifest instead of to the network.
func TestSafeCreateErrorSeparatesUnreachableFromRejected(t *testing.T) {
	unreachable := &url.Error{
		Op: "Post", URL: "https://localhost:18081/api/v1/applications",
		Err: errors.New("dial tcp [::1]:18081: connect: connection refused"),
	}
	if got := safeCreateError(unreachable); got != "Argo CD could not be reached" {
		t.Fatalf("connection refused was misreported: %q", got)
	}
	if got := safeCreateError(argoAPIError{status: 400}); got != "Argo CD did not accept the application" {
		t.Fatalf("API rejection was misreported: %q", got)
	}
	if got := safeCreateError(ErrApplicationConflict); got != "an Argo CD application with this name already exists" {
		t.Fatalf("conflict was misreported: %q", got)
	}
	// The raw transport error can echo request details, so it must not reach the client.
	if strings.Contains(safeCreateError(unreachable), "18081") {
		t.Fatal("transport detail leaked to the client message")
	}
}

func TestSyncRestartsDeploymentTimeoutWindow(t *testing.T) {
	target := model.ApplicationDeployment{
		ID: "target-1", ClusterName: "prod", SourceID: "aws",
		ProviderResourceID: "arn:cluster/prod", ArgoApplication: "payments",
		Status: "failed", SyncStatus: "Unknown", HealthStatus: "Unknown",
	}
	repository := &fakeRepository{record: model.ApplicationOnboarding{
		ID: "onboarding-1", Name: "payments", Namespace: "payments",
		ChartRepoURL: "repo", ChartName: "chart", ChartRevision: "1",
		ValuesRepositoryCloneURL: "https://github.com/GitOpsHub/payments.git",
		ValuesRevision:           "main", Targets: []model.ApplicationDeployment{target},
	}}
	client := &fakeArgoClient{
		state: ApplicationState{SyncStatus: "Synced", HealthStatus: "Healthy"},
	}
	service := &Service{
		store: repository,
		config: config.OnboardingConfig{
			ArgoNamespace: "argo-cd", ArgoProject: "default", RequestTimeout: time.Second,
		},
		clients: map[string]ArgoClient{targetKey("aws", "arn:cluster/prod"): client},
	}

	if _, err := service.Sync(context.Background(), "onboarding-1"); err != nil {
		t.Fatal(err)
	}

	if len(repository.restarted) != 1 || repository.restarted[0] != "onboarding-1" {
		t.Fatalf("sync did not reopen the timeout window: %#v", repository.restarted)
	}
}

func TestReconcileDoesNotRaceApplicationCreation(t *testing.T) {
	target := model.ApplicationDeployment{
		ID: "target-1", SourceID: "aws", ProviderResourceID: "arn:cluster/prod",
		ArgoApplication: "payments", Status: "creating",
		CreatedAt: time.Now(), UpdatedAt: time.Now(), AttemptStartedAt: time.Now(),
	}
	repository := &fakeRepository{active: []model.ApplicationDeployment{target}}
	client := &fakeArgoClient{getErr: errors.New("permission denied")}
	service := &Service{
		store: repository,
		config: config.OnboardingConfig{
			ArgoNamespace: "argo-cd", RequestTimeout: 10 * time.Second,
			DeploymentTimeout: 15 * time.Minute,
		},
		clients: map[string]ArgoClient{targetKey("aws", "arn:cluster/prod"): client},
	}

	service.reconcile(context.Background())

	if len(repository.updates) != 0 {
		t.Fatalf("creation result was overwritten by reconciliation: %#v", repository.updates)
	}
}

func TestGetAndListEnrichArgoApplicationLinks(t *testing.T) {
	repository := &fakeRepository{record: model.ApplicationOnboarding{
		ID: "onboarding-1", Name: "payments", Targets: []model.ApplicationDeployment{
			{
				ID: "target-1", SourceID: "aws", ProviderResourceID: "arn:cluster/prod",
				ArgoApplication: "payments api",
			},
			{
				ID: "target-2", SourceID: "gcp", ProviderResourceID: "projects/x/clusters/prod",
				ArgoApplication: "payments",
			},
		},
	}}
	linked := config.ArgoTarget{
		SourceID: "aws", ProviderResourceID: "arn:cluster/prod",
		UIURL: "https://argo.example.test", Username: "kubeops",
	}
	service := &Service{
		store:  repository,
		config: config.OnboardingConfig{PublicBaseURL: "https://kubeops.example.test"},
		linkTargets: map[string]config.ArgoTarget{
			targetKey("aws", "arn:cluster/prod"): linked,
		},
	}

	record, err := service.Get(context.Background(), "onboarding-1")
	if err != nil {
		t.Fatal(err)
	}
	// The link addresses this backend's Argo CD proxy, not the Argo CD server, so
	// the browser needs no Argo CD session and no trust in its certificate.
	wantURL := "https://kubeops.example.test/argo/" + linked.ProxyID() +
		"/applications/payments%20api"
	if record.Targets[0].ArgoApplicationURL != wantURL {
		t.Fatalf("unexpected Argo URL: %q", record.Targets[0].ArgoApplicationURL)
	}
	if record.Targets[0].ArgoUsername != "kubeops" {
		t.Fatalf("unexpected Argo username: %q", record.Targets[0].ArgoUsername)
	}
	// A cluster with no Argo CD target at all still advertises nothing.
	if record.Targets[1].ArgoApplicationURL != "" || record.Targets[1].ArgoUsername != "" {
		t.Fatalf("unexpected Argo access on unconfigured target: %#v", record.Targets[1])
	}

	page, err := service.List(context.Background(), model.ApplicationOnboardingFilter{
		Page: 2, PageSize: 5, Search: "pay", Status: "healthy",
	})
	if err != nil {
		t.Fatal(err)
	}
	if repository.filter.Page != 2 || repository.filter.PageSize != 5 ||
		repository.filter.Search != "pay" || repository.filter.Status != "healthy" {
		t.Fatalf("filter was not forwarded: %#v", repository.filter)
	}
	if page.Items[0].Targets[0].ArgoApplicationURL == "" {
		t.Fatalf("listed targets were not enriched: %#v", page.Items[0].Targets[0])
	}
}

// A target reachable by API token alone is still linkable, because the proxy signs
// requests with that token. Only the username, which exists for signing in to Argo
// CD directly, stays empty.
func TestEnrichLinksTokenOnlyTargetWithoutUsername(t *testing.T) {
	t.Setenv("ARGO_TOKEN", "token")
	service, err := NewService(&fakeRepository{}, config.OnboardingConfig{
		RequestTimeout: time.Second, PublicBaseURL: "https://kubeops.example.test",
		ArgoTargets: []config.ArgoTarget{{
			SourceID: "aws", ProviderResourceID: "arn:cluster/prod",
			ServerURL: "https://argo.example.test", Token: "token",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}

	targets := []model.ApplicationDeployment{{
		SourceID: "aws", ProviderResourceID: "arn:cluster/prod", ArgoApplication: "payments",
	}}
	service.enrichTargets(targets)

	if targets[0].ArgoApplicationURL == "" {
		t.Fatal("token-only target was not linked")
	}
	if targets[0].ArgoUsername != "" {
		t.Fatalf("unexpected username without UI credentials: %q", targets[0].ArgoUsername)
	}
}
