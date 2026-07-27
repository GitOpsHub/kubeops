package store

import (
	"context"
	"errors"
	"os"
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
		if _, err := repository.pool.Exec(context.Background(), "TRUNCATE sync_runs, clusters, cloud_sources CASCADE"); err != nil {
			t.Errorf("clean integration data: %v", err)
		}
		repository.Close()
	})

	if _, err := repository.pool.Exec(ctx, "TRUNCATE sync_runs, clusters, cloud_sources CASCADE"); err != nil {
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
	if err != nil || page.Total != 4 {
		t.Fatalf("expected four active clusters, got %#v, %v", page, err)
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
	if err != nil || active.Total != 3 {
		t.Fatalf("expected three active clusters, got %#v, %v", active, err)
	}
	all, err := repository.ListClusters(ctx, model.ClusterFilter{
		Page: 1, PageSize: 25, IncludeRemoved: true,
	})
	if err != nil || all.Total != 4 {
		t.Fatalf("expected one removed cluster to be retained, got %#v, %v", all, err)
	}

	runs, err := repository.ListSyncRuns(ctx, 10)
	if err != nil || len(runs) != 4 || runs[0].RemovedCount != 1 {
		t.Fatalf("unexpected sync history: %#v, %v", runs, err)
	}
}
