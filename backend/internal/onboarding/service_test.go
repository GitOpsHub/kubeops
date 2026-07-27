package onboarding

import (
	"bytes"
	"context"
	"testing"
	"time"

	"github.com/GitOpsHub/kubeops/backend/internal/config"
	"github.com/GitOpsHub/kubeops/backend/internal/model"
	"github.com/GitOpsHub/kubeops/backend/internal/secure"
)

type fakeRepository struct {
	clusters []model.Cluster
	record   model.ApplicationOnboarding
	active   []model.ApplicationDeployment
	updates  map[string]model.ApplicationDeployment
	access   model.EncryptedArgoAccess
}

func (f *fakeRepository) GetClustersByIDs(context.Context, []string) ([]model.Cluster, error) {
	return f.clusters, nil
}
func (f *fakeRepository) CreateApplicationOnboarding(
	_ context.Context,
	record model.ApplicationOnboarding,
	clusters []model.Cluster,
) (model.ApplicationOnboarding, error) {
	record.ID = "onboarding-1"
	record.Status = "progressing"
	record.CreatedAt = time.Now()
	for index, cluster := range clusters {
		record.Targets = append(record.Targets, model.ApplicationDeployment{
			ID: "target-" + string(rune('1'+index)), OnboardingID: record.ID,
			ClusterID: cluster.ID, ClusterName: cluster.Name, SourceID: cluster.SourceID,
			ProviderResourceID: cluster.ProviderResourceID, ArgoApplication: record.Name,
			Status: "creating", SyncStatus: "Unknown", HealthStatus: "Unknown",
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
	context.Context,
	int,
) ([]model.ApplicationOnboarding, error) {
	return []model.ApplicationOnboarding{f.record}, nil
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
func (f *fakeRepository) UpsertArgoAccess(
	_ context.Context,
	access model.EncryptedArgoAccess,
) error {
	f.access = access
	return nil
}

type fakeArgoClient struct {
	created ApplicationSpec
	state   ApplicationState
	err     error
}

type fakeValuesRepositoryManager struct {
	repository ValuesRepository
	err        error
	deleted    string
}

func (f *fakeValuesRepositoryManager) Provision(
	context.Context,
	string,
	string,
) (ValuesRepository, error) {
	return f.repository, f.err
}
func (f *fakeValuesRepositoryManager) Delete(_ context.Context, name string) error {
	f.deleted = name
	return nil
}

func (f *fakeArgoClient) CreateApplication(
	_ context.Context,
	spec ApplicationSpec,
) (ApplicationState, error) {
	f.created = spec
	return f.state, f.err
}
func (f *fakeArgoClient) GetApplication(
	context.Context,
	string,
	string,
) (ApplicationState, error) {
	return f.state, f.err
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
	if client.created.ValuesRepoURL != valuesManager.repository.CloneURL ||
		record.ValuesRepositoryURL != valuesManager.repository.URL {
		t.Fatalf("unexpected values repository: %#v, %#v", client.created, record)
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
