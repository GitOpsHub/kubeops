package onboarding

import (
	"context"
	"testing"
	"time"

	"github.com/GitOpsHub/kubeops/backend/internal/config"
	"github.com/GitOpsHub/kubeops/backend/internal/model"
)

type fakeRepository struct {
	clusters []model.Cluster
	record   model.ApplicationOnboarding
	active   []model.ApplicationDeployment
	updates  map[string]model.ApplicationDeployment
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

type fakeArgoClient struct {
	created ApplicationSpec
	state   ApplicationState
	err     error
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
	service := &Service{
		store: repository,
		config: config.OnboardingConfig{
			HelmRepoURL: "https://charts.example.test", HelmChart: "global-app",
			HelmRevision: "1.2.3", ArgoProject: "platform", ArgoNamespace: "argo-cd",
			RequestTimeout: time.Second,
		},
		clients: map[string]ArgoClient{targetKey("aws", "arn:cluster/prod"): client},
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
}

func TestCreateApplicationOnboardingValidation(t *testing.T) {
	service := &Service{config: config.OnboardingConfig{
		HelmRepoURL: "repo", HelmChart: "chart", HelmRevision: "1",
	}}
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
