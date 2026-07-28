package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"

	"github.com/GitOpsHub/kubeops/backend/internal/model"
)

func TestInventoryLifecycle(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}

	ctx := context.Background()
	repository, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := repository.pool.Exec(context.Background(), "TRUNCATE sync_runs, application_onboardings, clusters, cloud_sources CASCADE"); err != nil {
			t.Errorf("clean integration data: %v", err)
		}
		repository.Close()
	})

	if _, err := repository.pool.Exec(ctx, "TRUNCATE sync_runs, application_onboardings, clusters, cloud_sources CASCADE"); err != nil {
		t.Fatal(err)
	}
	sources := []model.CloudSource{
		{
			ID: "aws-test", Provider: model.ProviderAWS, Name: "AWS Test",
			ScopeID: "123456789012", Regions: []string{"us-east-1"}, Enabled: true,
		},
		{
			ID: "gcp-test", Provider: model.ProviderGCP, Name: "GCP Test",
			ScopeID: "test-project", Regions: []string{"-"}, Enabled: true,
		},
		{
			ID: "azure-test", Provider: model.ProviderAzure, Name: "Azure Test",
			ScopeID: "test-subscription", Regions: []string{"*"}, Enabled: true,
		},
		{
			ID: "docker-test", Provider: model.ProviderDocker, Name: "Docker Test",
			ScopeID: "local-docker", Regions: []string{"local"}, Enabled: true,
		},
		{
			ID: "minikube-test", Provider: model.ProviderMinikube, Name: "Minikube Test",
			ScopeID: "local-minikube", Regions: []string{"local"}, Enabled: true,
		},
	}
	if err := repository.UpsertSources(ctx, sources); err != nil {
		t.Fatal(err)
	}

	run, err := repository.QueueSync(ctx, sources[0].ID, "manual")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repository.QueueSync(ctx, sources[0].ID, "manual"); !errors.Is(err, ErrSyncAlreadyActive) {
		t.Fatalf("expected ErrSyncAlreadyActive, got %v", err)
	}
	claimed, err := repository.ClaimNextSync(ctx)
	if err != nil || claimed == nil || claimed.ID != run.ID {
		t.Fatalf("unexpected claimed run: %#v, %v", claimed, err)
	}

	nodeCount := int32(3)
	if err := repository.CompleteSync(ctx, *claimed, []model.Cluster{
		{
			Provider: model.ProviderAWS, ProviderResourceID: "cluster-a", Name: "cluster-a",
			Location: "us-east-1", KubernetesVersion: "1.34", Status: "active",
			EndpointAccess: "private", NodeCount: &nodeCount, Metadata: map[string]any{},
		},
		{
			Provider: model.ProviderAWS, ProviderResourceID: "cluster-b", Name: "cluster-b",
			Location: "us-east-1", KubernetesVersion: "1.34", Status: "active",
			EndpointAccess: "public", NodeCount: &nodeCount, Metadata: map[string]any{},
		},
	}); err != nil {
		t.Fatal(err)
	}

	for _, source := range sources[1:] {
		run, err := repository.QueueSync(ctx, source.ID, "manual")
		if err != nil {
			t.Fatal(err)
		}
		claimed, err := repository.ClaimNextSync(ctx)
		if err != nil || claimed == nil || claimed.ID != run.ID {
			t.Fatalf("unexpected %s run: %#v, %v", source.Provider, claimed, err)
		}
		nodeCount := int32(5)
		if err := repository.CompleteSync(ctx, *claimed, []model.Cluster{{
			Provider: source.Provider, ProviderResourceID: source.Provider + "-cluster",
			Name: source.Provider + "-cluster", Location: "global",
			KubernetesVersion: "1.34", Status: "running", EndpointAccess: "public",
			NodeCount: &nodeCount, Metadata: map[string]any{"mocked": true},
		}}); err != nil {
			t.Fatal(err)
		}
	}

	page, err := repository.ListClusters(ctx, model.ClusterFilter{Page: 1, PageSize: 25})
	if err != nil || page.Total != 6 {
		t.Fatalf("expected six active clusters, got %#v, %v", page, err)
	}
	accessInput := model.EncryptedArgoAccess{
		SourceID: page.Items[0].SourceID, ProviderResourceID: page.Items[0].ProviderResourceID,
		URL: "https://argo.example.test", Username: "kubeops",
		PasswordCiphertext: []byte("encrypted-password"), PasswordNonce: []byte("nonce-value"),
	}
	if err := repository.UpsertArgoAccess(ctx, accessInput); err != nil {
		t.Fatal(err)
	}
	access, err := repository.GetArgoAccessByClusterID(ctx, page.Items[0].ID)
	if err != nil || access.URL != accessInput.URL || access.Username != accessInput.Username ||
		string(access.PasswordCiphertext) != "encrypted-password" {
		t.Fatalf("unexpected Argo access: %#v, %v", access, err)
	}

	onboarding, err := repository.CreateApplicationOnboarding(ctx, model.ApplicationOnboarding{
		Name: "payments", Namespace: "payments", ChartRepoURL: "https://charts.example.test",
		ChartName: "global-app", ChartRevision: "1.2.3", ValuesDigest: "sha256:test",
		ValuesRepositoryURL:  "https://github.com/GitOpsHub/payments",
		ValuesRepositoryName: "payments", ValuesRevision: "main", ValuesCommitSHA: "commit-1",
	}, []model.Cluster{page.Items[0]})
	if err != nil {
		t.Fatal(err)
	}
	if len(onboarding.Targets) != 1 || onboarding.Targets[0].Status != "creating" {
		t.Fatalf("unexpected onboarding: %#v", onboarding)
	}
	if err := repository.UpdateApplicationDeployment(
		ctx, onboarding.Targets[0].ID, "healthy", "Synced", "Healthy", "",
	); err != nil {
		t.Fatal(err)
	}
	storedOnboarding, err := repository.GetApplicationOnboarding(ctx, onboarding.ID)
	if err != nil || storedOnboarding.Status != "healthy" ||
		storedOnboarding.Targets[0].HealthStatus != "Healthy" ||
		storedOnboarding.ValuesCommitSHA != "commit-1" {
		t.Fatalf("unexpected stored onboarding: %#v, %v", storedOnboarding, err)
	}

	if _, err := repository.CreateApplicationOnboarding(ctx, model.ApplicationOnboarding{
		Name: "checkout", Namespace: "storefront", ChartRepoURL: "https://charts.example.test",
		ChartName: "global-app", ChartRevision: "1.2.3", ValuesDigest: "sha256:test",
		ValuesRepositoryURL:  "https://github.com/GitOpsHub/checkout",
		ValuesRepositoryName: "checkout", ValuesRevision: "main", ValuesCommitSHA: "commit-2",
	}, []model.Cluster{page.Items[0]}); err != nil {
		t.Fatal(err)
	}

	onboardings, err := repository.ListApplicationOnboardings(
		ctx, model.ApplicationOnboardingFilter{Page: 1, PageSize: 1},
	)
	if err != nil || onboardings.Total != 2 || len(onboardings.Items) != 1 ||
		onboardings.Page != 1 || onboardings.PageSize != 1 {
		t.Fatalf("unexpected onboarding page: %#v, %v", onboardings, err)
	}
	secondPage, err := repository.ListApplicationOnboardings(
		ctx, model.ApplicationOnboardingFilter{Page: 2, PageSize: 1},
	)
	if err != nil || len(secondPage.Items) != 1 ||
		secondPage.Items[0].ID == onboardings.Items[0].ID {
		t.Fatalf("unexpected second onboarding page: %#v, %v", secondPage, err)
	}
	// Search is case-insensitive and spans both the name and the namespace.
	byNamespace, err := repository.ListApplicationOnboardings(
		ctx, model.ApplicationOnboardingFilter{Page: 1, PageSize: 20, Search: "STOREFRONT"},
	)
	if err != nil || byNamespace.Total != 1 || byNamespace.Items[0].Name != "checkout" {
		t.Fatalf("unexpected search result: %#v, %v", byNamespace, err)
	}
	byStatus, err := repository.ListApplicationOnboardings(
		ctx, model.ApplicationOnboardingFilter{Page: 1, PageSize: 20, Status: model.OnboardingHealthy},
	)
	if err != nil || byStatus.Total != 1 || byStatus.Items[0].Name != "payments" ||
		len(byStatus.Items[0].Targets) != 1 {
		t.Fatalf("unexpected status filter result: %#v, %v", byStatus, err)
	}

	run, err = repository.QueueSync(ctx, sources[0].ID, "scheduled")
	if err != nil {
		t.Fatal(err)
	}
	claimed, err = repository.ClaimNextSync(ctx)
	if err != nil || claimed == nil || claimed.ID != run.ID {
		t.Fatalf("unexpected second run: %#v, %v", claimed, err)
	}
	if err := repository.CompleteSync(ctx, *claimed, []model.Cluster{
		{
			Provider: model.ProviderAWS, ProviderResourceID: "cluster-a", Name: "cluster-a",
			Location: "us-east-1", KubernetesVersion: "1.35", Status: "active",
			EndpointAccess: "private", NodeCount: &nodeCount, Metadata: map[string]any{},
		},
	}); err != nil {
		t.Fatal(err)
	}

	active, err := repository.ListClusters(ctx, model.ClusterFilter{Page: 1, PageSize: 25})
	if err != nil || active.Total != 5 {
		t.Fatalf("expected five active clusters, got %#v, %v", active, err)
	}
	all, err := repository.ListClusters(ctx, model.ClusterFilter{
		Page: 1, PageSize: 25, IncludeRemoved: true,
	})
	if err != nil || all.Total != 6 {
		t.Fatalf("expected one removed cluster to be retained, got %#v, %v", all, err)
	}

	runs, err := repository.ListSyncRuns(ctx, 10)
	if err != nil || len(runs) != 6 || runs[0].RemovedCount != 1 {
		t.Fatalf("unexpected sync history: %#v, %v", runs, err)
	}
}

// TestConcurrentDeploymentUpdatesSettleParentStatus covers targets that finish at
// the same moment, which is what Create does when it fans out to every cluster.
// Before the parent row was locked first, the last writer could persist a total it
// computed before its sibling committed, stranding the onboarding on 'progressing'.
func TestConcurrentDeploymentUpdatesSettleParentStatus(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}

	ctx := context.Background()
	repository, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	truncate := "TRUNCATE sync_runs, application_onboardings, clusters, cloud_sources CASCADE"
	t.Cleanup(func() {
		if _, err := repository.pool.Exec(context.Background(), truncate); err != nil {
			t.Errorf("clean integration data: %v", err)
		}
		repository.Close()
	})
	if _, err := repository.pool.Exec(ctx, truncate); err != nil {
		t.Fatal(err)
	}

	if err := repository.UpsertSources(ctx, []model.CloudSource{{
		ID: "aws-test", Provider: model.ProviderAWS, Name: "AWS Test",
		ScopeID: "123456789012", Regions: []string{"us-east-1"}, Enabled: true,
	}}); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.QueueSync(ctx, "aws-test", "manual"); err != nil {
		t.Fatal(err)
	}
	claimed, err := repository.ClaimNextSync(ctx)
	if err != nil || claimed == nil {
		t.Fatalf("claim sync: %#v, %v", claimed, err)
	}
	if err := repository.CompleteSync(ctx, *claimed, []model.Cluster{
		{
			Provider: model.ProviderAWS, ProviderResourceID: "cluster-east", Name: "east",
			Location: "us-east-1", Status: "active", EndpointAccess: "public",
			Metadata: map[string]any{},
		},
		{
			Provider: model.ProviderAWS, ProviderResourceID: "cluster-west", Name: "west",
			Location: "us-west-2", Status: "active", EndpointAccess: "public",
			Metadata: map[string]any{},
		},
	}); err != nil {
		t.Fatal(err)
	}
	clusterPage, err := repository.ListClusters(ctx, model.ClusterFilter{Page: 1, PageSize: 25})
	if err != nil || len(clusterPage.Items) != 2 {
		t.Fatalf("expected two clusters: %#v, %v", clusterPage, err)
	}

	// Repeat so an unlucky interleaving is caught rather than passing by chance.
	for attempt := 0; attempt < 15; attempt++ {
		onboarding, err := repository.CreateApplicationOnboarding(ctx, model.ApplicationOnboarding{
			Name:      fmt.Sprintf("race-%d", attempt),
			Namespace: "race", ChartRepoURL: "repo", ChartName: "chart",
			ChartRevision: "1", ValuesDigest: "digest", ValuesRepositoryURL: "url",
			ValuesRepositoryName: "name", ValuesRevision: "main", ValuesCommitSHA: "sha",
		}, clusterPage.Items)
		if err != nil {
			t.Fatal(err)
		}

		var wait sync.WaitGroup
		errs := make(chan error, len(onboarding.Targets))
		for _, target := range onboarding.Targets {
			wait.Add(1)
			go func() {
				defer wait.Done()
				if err := repository.UpdateApplicationDeployment(
					ctx, target.ID, "failed", "Unknown", "Unknown", "rejected",
				); err != nil {
					errs <- err
				}
			}()
		}
		wait.Wait()
		close(errs)
		if err := <-errs; err != nil {
			t.Fatal(err)
		}

		settled, err := repository.GetApplicationOnboarding(ctx, onboarding.ID)
		if err != nil {
			t.Fatal(err)
		}
		if settled.Status != model.OnboardingFailed {
			t.Fatalf(
				"attempt %d: every target failed but the onboarding is %q",
				attempt, settled.Status,
			)
		}
		if settled.CompletedAt == nil {
			t.Fatalf("attempt %d: terminal onboarding has no completed_at", attempt)
		}
	}
}
