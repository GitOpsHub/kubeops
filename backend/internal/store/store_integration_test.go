package store

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/GitOpsHub/kubeops/backend/internal/model"
)

const truncateIntegrationData = "TRUNCATE sync_runs, application_onboardings, clusters, cloud_sources CASCADE"

// integrationDatabaseURL resolves the database these tests are allowed to wipe.
// They TRUNCATE every table, so pointing TEST_DATABASE_URL at the local dev
// database destroys real onboarding records — which is exactly what happened
// when the Makefile target still used the `kubeops` database. Only a database
// named with a `_test` suffix is accepted, and never the one DATABASE_URL
// already names. Set KUBEOPS_ALLOW_DESTRUCTIVE_TESTS=1 to bypass both checks.
func integrationDatabaseURL(t *testing.T) string {
	t.Helper()

	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	if os.Getenv("KUBEOPS_ALLOW_DESTRUCTIVE_TESTS") == "1" {
		return databaseURL
	}

	name, target, err := databaseIdentity(databaseURL)
	if err != nil {
		t.Fatalf("parse TEST_DATABASE_URL: %v", err)
	}
	if developmentURL := os.Getenv("DATABASE_URL"); developmentURL != "" {
		if _, developmentTarget, err := databaseIdentity(developmentURL); err == nil && developmentTarget == target {
			t.Fatalf("refusing to truncate %s: TEST_DATABASE_URL points at the same database as DATABASE_URL", target)
		}
	}
	if !strings.HasSuffix(name, "_test") {
		t.Fatalf("refusing to truncate %s: these tests TRUNCATE every table, so TEST_DATABASE_URL must name a database ending in _test (for example kubeops_test)", target)
	}
	return databaseURL
}

// databaseIdentity reports the database name of a PostgreSQL URL plus a
// host-qualified identifier used to tell two connection strings apart.
func databaseIdentity(databaseURL string) (name string, target string, err error) {
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		return "", "", err
	}
	name = strings.TrimPrefix(parsed.Path, "/")
	if parsed.Host == "" || name == "" {
		return "", "", fmt.Errorf("%q is not a postgres://host/database URL", parsed.Redacted())
	}
	return name, parsed.Host + "/" + name, nil
}

func TestInventoryLifecycle(t *testing.T) {
	databaseURL := integrationDatabaseURL(t)

	ctx := context.Background()
	repository, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := repository.pool.Exec(context.Background(), truncateIntegrationData); err != nil {
			t.Errorf("clean integration data: %v", err)
		}
		repository.Close()
	})

	if _, err := repository.pool.Exec(ctx, truncateIntegrationData); err != nil {
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
	interruptedRunID := claimed.ID

	if err := repository.RecoverRunningSyncs(ctx); err != nil {
		t.Fatal(err)
	}
	var recoveredStatus, recoveredError, sourceStatus, sourceError string
	var hasCompletedAt bool
	if err := repository.pool.QueryRow(ctx, `
		SELECT status, error, completed_at IS NOT NULL
		FROM sync_runs WHERE id = $1`, claimed.ID,
	).Scan(&recoveredStatus, &recoveredError, &hasCompletedAt); err != nil {
		t.Fatal(err)
	}
	if err := repository.pool.QueryRow(ctx, `
		SELECT last_sync_status, last_sync_error
		FROM cloud_sources WHERE id = $1`, sources[0].ID,
	).Scan(&sourceStatus, &sourceError); err != nil {
		t.Fatal(err)
	}
	if recoveredStatus != "failed" || !hasCompletedAt ||
		recoveredError != "sync interrupted by backend restart" ||
		sourceStatus != "failed" || sourceError != recoveredError {
		t.Fatalf(
			"unexpected recovered sync: status=%q error=%q completed=%t source_status=%q source_error=%q",
			recoveredStatus, recoveredError, hasCompletedAt, sourceStatus, sourceError,
		)
	}

	run, err = repository.QueueSync(ctx, sources[0].ID, "manual")
	if err != nil {
		t.Fatal(err)
	}
	claimed, err = repository.ClaimNextSync(ctx)
	if err != nil || claimed == nil || claimed.ID != run.ID {
		t.Fatalf("unexpected replacement run: %#v, %v", claimed, err)
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
		ValuesRepositoryURL:      "https://github.com/GitOpsHub/payments",
		ValuesRepositoryCloneURL: "https://github.com/GitOpsHub/payments.git",
		ValuesRepositoryName:     "payments", ValuesRevision: "main", ValuesCommitSHA: "commit-1",
	}, []model.Cluster{page.Items[0]}, map[string]bool{page.Items[0].Location: true})
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
		!storedOnboarding.Targets[0].HasRegionValues ||
		storedOnboarding.ValuesCommitSHA != "commit-1" ||
		storedOnboarding.ValuesRepositoryCloneURL != "https://github.com/GitOpsHub/payments.git" {
		t.Fatalf("unexpected stored onboarding: %#v, %v", storedOnboarding, err)
	}

	if _, err := repository.CreateApplicationOnboarding(ctx, model.ApplicationOnboarding{
		Name: "checkout", Namespace: "storefront", ChartRepoURL: "https://charts.example.test",
		ChartName: "global-app", ChartRevision: "1.2.3", ValuesDigest: "sha256:test",
		ValuesRepositoryURL:  "https://github.com/GitOpsHub/checkout",
		ValuesRepositoryName: "checkout", ValuesRevision: "main", ValuesCommitSHA: "commit-2",
	}, []model.Cluster{page.Items[0]}, nil); err != nil {
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
	if err := repository.UpdateApplicationDeployment(
		ctx, onboarding.Targets[0].ID, "offboarded", "Unknown", "Missing",
		"Removed from the cluster; GitHub values were preserved",
	); err != nil {
		t.Fatal(err)
	}
	offboarded, err := repository.GetApplicationOnboarding(ctx, onboarding.ID)
	if err != nil || offboarded.Status != "offboarded" ||
		offboarded.ValuesRepositoryURL != "https://github.com/GitOpsHub/payments" {
		t.Fatalf("unexpected offboarded onboarding: %#v, %v", offboarded, err)
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
	if err != nil || len(runs) != 7 || runs[0].RemovedCount != 1 ||
		runs[6].ID != interruptedRunID || runs[6].Status != "failed" ||
		runs[6].Error != "sync interrupted by backend restart" {
		t.Fatalf("unexpected sync history: %#v, %v", runs, err)
	}
}

// TestConcurrentDeploymentUpdatesSettleParentStatus covers targets that finish at
// the same moment, which is what Create does when it fans out to every cluster.
// Before the parent row was locked first, the last writer could persist a total it
// computed before its sibling committed, stranding the onboarding on 'progressing'.
func TestConcurrentDeploymentUpdatesSettleParentStatus(t *testing.T) {
	databaseURL := integrationDatabaseURL(t)

	ctx := context.Background()
	repository, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := repository.pool.Exec(context.Background(), truncateIntegrationData); err != nil {
			t.Errorf("clean integration data: %v", err)
		}
		repository.Close()
	})
	if _, err := repository.pool.Exec(ctx, truncateIntegrationData); err != nil {
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
		}, clusterPage.Items, nil)
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
