package store

import (
	"context"
	"fmt"
	"math"
	"net/url"
	"sort"
	"time"

	"github.com/GitOpsHub/kubeops/backend/internal/model"
)

// SourceStaleAfter matches the UI's staleness threshold for a source whose
// last successful sync is too old to trust (frontend/src/lib/providers.ts).
const SourceStaleAfter = 11 * time.Minute

const (
	overviewRecentRuns   = 10
	overviewAttentionMax = 20
)

// clusterAttentionStatuses are the lowercased provider states that mean a
// cluster is unhealthy rather than merely transitioning.
var clusterAttentionStatuses = []string{"failed", "error", "degraded"}

// Every day series covers the last 14 UTC days, oldest first, ending today.
const overviewDays = `
	SELECT generate_series(
		date_trunc('day', NOW() AT TIME ZONE 'UTC') - INTERVAL '13 days',
		date_trunc('day', NOW() AT TIME ZONE 'UTC'),
		INTERVAL '1 day'
	) AS day`

// Overview aggregates the dashboard. sourceIDs scopes clusters, sources, and
// sync runs the same way model.ClusterFilter.SourceIDs does: nil disables
// scoping and an empty slice matches nothing. Applications are not scoped,
// matching the application list endpoint.
func (s *Store) Overview(ctx context.Context, sourceIDs []string) (model.OverviewStats, error) {
	stats := model.OverviewStats{
		GeneratedAt: time.Now().UTC(),
		Clusters: model.OverviewClusters{
			ByProvider: map[string]int{}, ByStatus: map[string]int{},
		},
		Applications: model.OverviewApplications{
			ByStatus: map[string]int{},
			Targets:  model.OverviewTargets{ByHealth: map[string]int{}, BySync: map[string]int{}},
		},
		SyncRuns:  model.OverviewSyncRuns{Recent: []model.SyncRun{}},
		Attention: []model.AttentionItem{},
	}
	steps := []func(context.Context, []string, *model.OverviewStats) error{
		s.overviewClusters, s.overviewApplications, s.overviewSyncRuns, s.overviewAttention,
	}
	for _, step := range steps {
		if err := step(ctx, sourceIDs, &stats); err != nil {
			return model.OverviewStats{}, err
		}
	}
	return stats, nil
}

func (s *Store) overviewClusters(ctx context.Context, sourceIDs []string, stats *model.OverviewStats) error {
	rows, err := s.pool.Query(ctx, `
		SELECT provider, status, COUNT(*)
		FROM clusters
		WHERE removed_at IS NULL AND ($1::text[] IS NULL OR source_id = ANY($1))
		GROUP BY provider, status`, sourceIDs)
	if err != nil {
		return fmt.Errorf("count clusters: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var provider, status string
		var count int
		if err := rows.Scan(&provider, &status, &count); err != nil {
			return err
		}
		stats.Clusters.Total += count
		stats.Clusters.ByProvider[provider] += count
		stats.Clusters.ByStatus[status] += count
	}
	if err := rows.Err(); err != nil {
		return err
	}

	series, err := s.pool.Query(ctx, `
		WITH days AS (`+overviewDays+`)
		SELECT to_char(d.day, 'YYYY-MM-DD'), (
			SELECT COUNT(*) FROM clusters c
			WHERE ($1::text[] IS NULL OR c.source_id = ANY($1))
			  AND c.first_seen_at < (d.day + INTERVAL '1 day') AT TIME ZONE 'UTC'
			  AND (c.removed_at IS NULL OR c.removed_at >= (d.day + INTERVAL '1 day') AT TIME ZONE 'UTC')
		)
		FROM days d
		ORDER BY d.day`, sourceIDs)
	if err != nil {
		return fmt.Errorf("count cluster history: %w", err)
	}
	defer series.Close()
	stats.Clusters.Series14d = make([]model.DailyCount, 0, 14)
	for series.Next() {
		var day model.DailyCount
		if err := series.Scan(&day.Date, &day.Total); err != nil {
			return err
		}
		stats.Clusters.Series14d = append(stats.Clusters.Series14d, day)
	}
	return series.Err()
}

func (s *Store) overviewApplications(ctx context.Context, _ []string, stats *model.OverviewStats) error {
	rows, err := s.pool.Query(ctx, `
		SELECT status, COUNT(*) FROM application_onboardings
		WHERE status <> 'offboarded'
		GROUP BY status`)
	if err != nil {
		return fmt.Errorf("count applications: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var status string
		var count int
		if err := rows.Scan(&status, &count); err != nil {
			return err
		}
		stats.Applications.Total += count
		stats.Applications.ByStatus[status] = count
	}
	if err := rows.Err(); err != nil {
		return err
	}

	targets, err := s.pool.Query(ctx, `
		SELECT d.health_status, d.sync_status, COUNT(*)
		FROM application_deployments d
		JOIN application_onboardings o ON o.id = d.onboarding_id
		WHERE o.status <> 'offboarded' AND d.status <> 'offboarded'
		GROUP BY d.health_status, d.sync_status`)
	if err != nil {
		return fmt.Errorf("count application targets: %w", err)
	}
	defer targets.Close()
	for targets.Next() {
		var health, syncStatus string
		var count int
		if err := targets.Scan(&health, &syncStatus, &count); err != nil {
			return err
		}
		stats.Applications.Targets.Total += count
		stats.Applications.Targets.ByHealth[health] += count
		stats.Applications.Targets.BySync[syncStatus] += count
	}
	return targets.Err()
}

func (s *Store) overviewSyncRuns(ctx context.Context, sourceIDs []string, stats *model.OverviewStats) error {
	if err := s.pool.QueryRow(ctx, `
		SELECT
			COUNT(*) FILTER (WHERE status = 'succeeded' AND completed_at >= NOW() - INTERVAL '24 hours'),
			COUNT(*) FILTER (WHERE status = 'failed' AND completed_at >= NOW() - INTERVAL '24 hours'),
			COUNT(*) FILTER (WHERE status IN ('queued', 'running') AND queued_at >= NOW() - INTERVAL '24 hours')
		FROM sync_runs
		WHERE $1::text[] IS NULL OR source_id = ANY($1)`, sourceIDs,
	).Scan(
		&stats.SyncRuns.Last24h.Succeeded, &stats.SyncRuns.Last24h.Failed,
		&stats.SyncRuns.Last24h.Running,
	); err != nil {
		return fmt.Errorf("count recent sync runs: %w", err)
	}

	series, err := s.pool.Query(ctx, `
		WITH days AS (`+overviewDays+`)
		SELECT to_char(d.day, 'YYYY-MM-DD'),
			COUNT(r.id) FILTER (WHERE r.status = 'succeeded'),
			COUNT(r.id) FILTER (WHERE r.status = 'failed'),
			percentile_cont(0.5) WITHIN GROUP (
				ORDER BY EXTRACT(EPOCH FROM r.completed_at - r.started_at) * 1000
			) FILTER (WHERE r.status = 'succeeded' AND r.started_at IS NOT NULL),
			percentile_cont(0.95) WITHIN GROUP (
				ORDER BY EXTRACT(EPOCH FROM r.completed_at - r.started_at) * 1000
			) FILTER (WHERE r.status = 'succeeded' AND r.started_at IS NOT NULL)
		FROM days d
		LEFT JOIN sync_runs r
		  ON r.completed_at >= d.day AT TIME ZONE 'UTC'
		 AND r.completed_at < (d.day + INTERVAL '1 day') AT TIME ZONE 'UTC'
		 AND r.status IN ('succeeded', 'failed')
		 AND ($1::text[] IS NULL OR r.source_id = ANY($1))
		GROUP BY d.day
		ORDER BY d.day`, sourceIDs)
	if err != nil {
		return fmt.Errorf("aggregate sync run history: %w", err)
	}
	defer series.Close()
	stats.SyncRuns.Series14d = make([]model.SyncRunDay, 0, 14)
	for series.Next() {
		var day model.SyncRunDay
		var p50, p95 *float64
		if err := series.Scan(&day.Date, &day.Succeeded, &day.Failed, &p50, &p95); err != nil {
			return err
		}
		day.P50Ms, day.P95Ms = roundedMillis(p50), roundedMillis(p95)
		stats.SyncRuns.Series14d = append(stats.SyncRuns.Series14d, day)
	}
	if err := series.Err(); err != nil {
		return err
	}

	recent, err := s.pool.Query(ctx, `
		SELECT r.id::text, r.source_id, s.name, s.provider, r.trigger, r.status,
			r.discovered_count, r.changed_count, r.removed_count, r.error,
			r.queued_at, r.started_at, r.completed_at
		FROM sync_runs r
		JOIN cloud_sources s ON s.id = r.source_id
		WHERE $1::text[] IS NULL OR r.source_id = ANY($1)
		ORDER BY r.queued_at DESC, r.id
		LIMIT $2`, sourceIDs, overviewRecentRuns)
	if err != nil {
		return fmt.Errorf("list recent sync runs: %w", err)
	}
	defer recent.Close()
	for recent.Next() {
		var run model.SyncRun
		if err := recent.Scan(
			&run.ID, &run.SourceID, &run.SourceName, &run.Provider, &run.Trigger,
			&run.Status, &run.DiscoveredCount, &run.ChangedCount, &run.RemovedCount,
			&run.Error, &run.QueuedAt, &run.StartedAt, &run.CompletedAt,
		); err != nil {
			return err
		}
		stats.SyncRuns.Recent = append(stats.SyncRuns.Recent, run)
	}
	return recent.Err()
}

func roundedMillis(value *float64) *int64 {
	if value == nil {
		return nil
	}
	rounded := int64(math.Round(*value))
	return &rounded
}

// overviewAttention lists what an operator should look at, worst first:
// failures before degraded or partial states before stale sources. Each group
// is capped in SQL so one noisy category cannot hide the others entirely.
func (s *Store) overviewAttention(ctx context.Context, sourceIDs []string, stats *model.OverviewStats) error {
	type ranked struct {
		severity int
		item     model.AttentionItem
	}
	var items []ranked

	applications, err := s.pool.Query(ctx, `
		SELECT o.id::text, o.name, o.status, COALESCE((
			SELECT d.message FROM application_deployments d
			WHERE d.onboarding_id = o.id AND d.status = 'failed' AND d.message <> ''
			ORDER BY d.updated_at DESC LIMIT 1
		), '')
		FROM application_onboardings o
		WHERE o.status IN ('failed', 'partial')
		ORDER BY o.updated_at DESC
		LIMIT $1`, overviewAttentionMax)
	if err != nil {
		return fmt.Errorf("list applications needing attention: %w", err)
	}
	defer applications.Close()
	for applications.Next() {
		var item model.AttentionItem
		if err := applications.Scan(&item.ID, &item.Name, &item.Status, &item.Message); err != nil {
			return err
		}
		item.Kind = model.AttentionApplication
		item.Href = "/applications/" + url.PathEscape(item.ID)
		severity := 1
		if item.Status == model.OnboardingFailed {
			severity = 0
		}
		items = append(items, ranked{severity, item})
	}
	if err := applications.Err(); err != nil {
		return err
	}

	clusters, err := s.pool.Query(ctx, `
		SELECT id::text, name, status, source_id
		FROM clusters
		WHERE removed_at IS NULL AND status = ANY($2)
		  AND ($1::text[] IS NULL OR source_id = ANY($1))
		ORDER BY updated_at DESC
		LIMIT $3`, sourceIDs, clusterAttentionStatuses, overviewAttentionMax)
	if err != nil {
		return fmt.Errorf("list clusters needing attention: %w", err)
	}
	defer clusters.Close()
	for clusters.Next() {
		var item model.AttentionItem
		var sourceID string
		if err := clusters.Scan(&item.ID, &item.Name, &item.Status, &sourceID); err != nil {
			return err
		}
		item.Kind = model.AttentionCluster
		item.Message = "The provider reports this cluster as " + item.Status
		item.Href = "/clusters?" + url.Values{
			"source": {sourceID}, "status": {item.Status}, "search": {item.Name},
		}.Encode()
		severity := 1
		if item.Status != "degraded" {
			severity = 0
		}
		items = append(items, ranked{severity, item})
	}
	if err := clusters.Err(); err != nil {
		return err
	}

	sources, err := s.pool.Query(ctx, `
		SELECT id, name, last_sync_status, last_sync_error
		FROM cloud_sources
		WHERE enabled
		  AND ($1::text[] IS NULL OR id = ANY($1))
		  AND (last_sync_status = 'failed'
		    OR (last_sync_at IS NOT NULL AND last_sync_at < NOW() - make_interval(secs => $2)))
		ORDER BY last_sync_at NULLS FIRST
		LIMIT $3`, sourceIDs, SourceStaleAfter.Seconds(), overviewAttentionMax)
	if err != nil {
		return fmt.Errorf("list sources needing attention: %w", err)
	}
	defer sources.Close()
	for sources.Next() {
		var item model.AttentionItem
		var lastStatus, lastError string
		if err := sources.Scan(&item.ID, &item.Name, &lastStatus, &lastError); err != nil {
			return err
		}
		item.Kind = model.AttentionSource
		item.Href = "/sources?" + url.Values{"source": {item.ID}}.Encode()
		severity := 2
		if lastStatus == "failed" {
			severity = 0
			item.Status = "failed"
			item.Message = lastError
		} else {
			item.Status = "stale"
			item.Message = fmt.Sprintf(
				"No successful sync in the last %d minutes", int(SourceStaleAfter.Minutes()),
			)
		}
		items = append(items, ranked{severity, item})
	}
	if err := sources.Err(); err != nil {
		return err
	}

	kindOrder := map[string]int{
		model.AttentionApplication: 0, model.AttentionCluster: 1, model.AttentionSource: 2,
	}
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].severity != items[j].severity {
			return items[i].severity < items[j].severity
		}
		if kindOrder[items[i].item.Kind] != kindOrder[items[j].item.Kind] {
			return kindOrder[items[i].item.Kind] < kindOrder[items[j].item.Kind]
		}
		return items[i].item.Name < items[j].item.Name
	})
	for _, entry := range items {
		if len(stats.Attention) == overviewAttentionMax {
			break
		}
		stats.Attention = append(stats.Attention, entry.item)
	}
	return nil
}
