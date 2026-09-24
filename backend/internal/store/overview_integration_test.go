package store

import (
	"context"
	"reflect"
	"testing"

	"github.com/GitOpsHub/kubeops/backend/internal/model"
)

func TestOverviewAggregates(t *testing.T) {
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
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := repository.pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}

	// azure-x stands in for a source a previous deployment configured: it is in
	// the database but outside the scope, so none of its rows may be counted.
	if err := repository.UpsertSources(ctx, []model.CloudSource{
		{ID: "aws-a", Provider: model.ProviderAWS, Name: "AWS A", ScopeID: "1", Enabled: true},
		{ID: "gcp-b", Provider: model.ProviderGCP, Name: "GCP B", ScopeID: "2", Enabled: true},
		{ID: "azure-x", Provider: model.ProviderAzure, Name: "Azure X", ScopeID: "3", Enabled: true},
	}); err != nil {
		t.Fatal(err)
	}
	exec(`UPDATE cloud_sources SET last_sync_status = 'succeeded',
		last_sync_at = NOW() - INTERVAL '30 minutes' WHERE id = 'aws-a'`)
	exec(`UPDATE cloud_sources SET last_sync_status = 'failed', last_sync_error = 'boom',
		last_sync_at = NOW() WHERE id IN ('gcp-b', 'azure-x')`)

	exec(`INSERT INTO clusters (source_id, provider, provider_resource_id, name, location,
			status, first_seen_at, removed_at) VALUES
		('aws-a', 'aws', 'c1', 'c1', 'us-east-1', 'active', NOW() - INTERVAL '20 days', NULL),
		('aws-a', 'aws', 'c2', 'c2', 'us-east-1', 'failed', NOW() - INTERVAL '3 days', NULL),
		('gcp-b', 'gcp', 'c3', 'c3', 'us-east1', 'running', NOW() - INTERVAL '20 days',
			NOW() - INTERVAL '5 days'),
		('gcp-b', 'gcp', 'c4', 'c4', 'us-east1', 'degraded', NOW(), NULL),
		('azure-x', 'azure', 'c5', 'c5', 'eastus', 'failed', NOW() - INTERVAL '20 days', NULL)`)

	// Succeeded runs today take 1s, 2s and 3s; one more took 4s two days ago.
	exec(`INSERT INTO sync_runs (source_id, trigger, status, queued_at, started_at, completed_at) VALUES
		('aws-a', 'manual', 'succeeded', NOW(), NOW() - INTERVAL '1 second', NOW()),
		('aws-a', 'manual', 'succeeded', NOW(), NOW() - INTERVAL '2 seconds', NOW()),
		('aws-a', 'manual', 'succeeded', NOW(), NOW() - INTERVAL '3 seconds', NOW()),
		('aws-a', 'manual', 'failed', NOW(), NOW() - INTERVAL '9 minutes', NOW()),
		('aws-a', 'manual', 'succeeded', NOW() - INTERVAL '2 days',
			NOW() - INTERVAL '2 days' - INTERVAL '4 seconds', NOW() - INTERVAL '2 days'),
		('gcp-b', 'manual', 'running', NOW(), NOW(), NULL),
		('azure-x', 'manual', 'succeeded', NOW(), NOW() - INTERVAL '1 second', NOW())`)

	clusters, err := repository.GetClustersByIDs(ctx, clusterIDs(t, repository, "c1", "c2"))
	if err != nil || len(clusters) != 2 {
		t.Fatalf("load clusters: %#v, %v", clusters, err)
	}
	onboard := func(name string, targets []model.Cluster, statuses ...[4]string) {
		t.Helper()
		record, err := repository.CreateApplicationOnboarding(ctx, model.ApplicationOnboarding{
			Name: name, Namespace: name, ChartRepoURL: "repo", ChartName: "chart",
			ChartRevision: "1", ValuesDigest: "sha256:test",
		}, targets, nil)
		if err != nil {
			t.Fatal(err)
		}
		for index, status := range statuses {
			if err := repository.UpdateApplicationDeployment(
				ctx, record.Targets[index].ID, status[0], status[1], status[2], status[3],
			); err != nil {
				t.Fatal(err)
			}
		}
	}
	onboard("alpha", clusters[:1], [4]string{"failed", "OutOfSync", "Degraded", "image pull failed"})
	onboard("beta", clusters,
		[4]string{"healthy", "Synced", "Healthy", ""},
		[4]string{"failed", "Unknown", "Missing", ""})
	onboard("gamma", clusters[:1], [4]string{"offboarded", "Unknown", "Missing", ""})

	stats, err := repository.Overview(ctx, []string{"aws-a", "gcp-b"})
	if err != nil {
		t.Fatal(err)
	}

	if stats.Clusters.Total != 3 ||
		!reflect.DeepEqual(stats.Clusters.ByProvider, map[string]int{"aws": 2, "gcp": 1}) ||
		!reflect.DeepEqual(stats.Clusters.ByStatus, map[string]int{"active": 1, "failed": 1, "degraded": 1}) {
		t.Fatalf("unexpected cluster counts: %#v", stats.Clusters)
	}
	if len(stats.Clusters.Series14d) != 14 {
		t.Fatalf("expected 14 days of cluster history, got %d", len(stats.Clusters.Series14d))
	}
	// Index 13 is today. c3 was removed five days ago and c2 appeared three
	// days ago, so the fleet reads 2, 2 (six days ago), 1, 2 (three days ago), 3.
	for index, want := range map[int]int{0: 2, 7: 2, 8: 1, 10: 2, 13: 3} {
		if got := stats.Clusters.Series14d[index].Total; got != want {
			t.Fatalf("cluster history day %d: expected %d, got %d (%#v)",
				index, want, got, stats.Clusters.Series14d)
		}
	}

	if stats.Applications.Total != 2 ||
		!reflect.DeepEqual(stats.Applications.ByStatus, map[string]int{"failed": 1, "partial": 1}) {
		t.Fatalf("unexpected application counts: %#v", stats.Applications)
	}
	targets := stats.Applications.Targets
	if targets.Total != 3 ||
		!reflect.DeepEqual(targets.ByHealth, map[string]int{"Degraded": 1, "Healthy": 1, "Missing": 1}) ||
		!reflect.DeepEqual(targets.BySync, map[string]int{"OutOfSync": 1, "Synced": 1, "Unknown": 1}) {
		t.Fatalf("unexpected target counts: %#v", targets)
	}

	if stats.SyncRuns.Last24h != (model.SyncRunCounts{Succeeded: 3, Failed: 1, Running: 1}) {
		t.Fatalf("unexpected 24h sync counts: %#v", stats.SyncRuns.Last24h)
	}
	series := stats.SyncRuns.Series14d
	if len(series) != 14 {
		t.Fatalf("expected 14 days of sync history, got %d", len(series))
	}
	today, twoDaysAgo, quiet := series[13], series[11], series[12]
	if today.Succeeded != 3 || today.Failed != 1 || millis(today.P50Ms) != 2000 || millis(today.P95Ms) != 2900 {
		t.Fatalf("unexpected sync history today: %#v p50=%d p95=%d",
			today, millis(today.P50Ms), millis(today.P95Ms))
	}
	if twoDaysAgo.Succeeded != 1 || millis(twoDaysAgo.P50Ms) != 4000 || millis(twoDaysAgo.P95Ms) != 4000 {
		t.Fatalf("unexpected sync history two days ago: %#v", twoDaysAgo)
	}
	if quiet.Succeeded != 0 || quiet.P50Ms != nil || quiet.P95Ms != nil {
		t.Fatalf("a day without runs must have null percentiles: %#v", quiet)
	}
	if len(stats.SyncRuns.Recent) != 6 {
		t.Fatalf("expected the six scoped runs, got %d", len(stats.SyncRuns.Recent))
	}
	for _, run := range stats.SyncRuns.Recent {
		if run.SourceID == "azure-x" || run.SourceName == "" {
			t.Fatalf("unexpected recent run: %#v", run)
		}
	}

	type entry struct{ kind, name, status string }
	var attention []entry
	for _, item := range stats.Attention {
		attention = append(attention, entry{item.Kind, item.Name, item.Status})
		if item.Href == "" || item.ID == "" {
			t.Fatalf("attention item without a link: %#v", item)
		}
	}
	want := []entry{
		{model.AttentionApplication, "alpha", "failed"},
		{model.AttentionCluster, "c2", "failed"},
		{model.AttentionSource, "GCP B", "failed"},
		{model.AttentionApplication, "beta", "partial"},
		{model.AttentionCluster, "c4", "degraded"},
		{model.AttentionSource, "AWS A", "stale"},
	}
	if !reflect.DeepEqual(attention, want) {
		t.Fatalf("unexpected attention order:\n got %#v\nwant %#v", attention, want)
	}
	if stats.Attention[0].Message != "image pull failed" ||
		stats.Attention[0].Href != "/applications/"+stats.Attention[0].ID ||
		stats.Attention[2].Message != "boom" || stats.Attention[2].Href != "/sources?source=gcp-b" {
		t.Fatalf("unexpected attention details: %#v", stats.Attention)
	}

	unscoped, err := repository.Overview(ctx, nil)
	if err != nil || unscoped.Clusters.Total != 4 || len(unscoped.SyncRuns.Recent) != 7 {
		t.Fatalf("nil scope must include every source: %#v, %v", unscoped.Clusters, err)
	}
	empty, err := repository.Overview(ctx, []string{})
	if err != nil || empty.Clusters.Total != 0 || len(empty.SyncRuns.Recent) != 0 ||
		len(empty.Clusters.Series14d) != 14 || empty.Applications.Total != 2 {
		t.Fatalf("empty scope must match no inventory: %#v, %v", empty, err)
	}
}

func clusterIDs(t *testing.T, repository *Store, names ...string) []string {
	t.Helper()
	rows, err := repository.pool.Query(context.Background(),
		`SELECT id::text FROM clusters WHERE name = ANY($1) ORDER BY name`, names)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	return ids
}

func millis(value *int64) int64 {
	if value == nil {
		return -1
	}
	return *value
}
