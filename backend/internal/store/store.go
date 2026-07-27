package store

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"sort"
	"strings"

	"github.com/GitOpsHub/kubeops/backend/internal/model"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrSyncAlreadyActive = errors.New("sync already active")

//go:embed migrations/*.sql
var migrationFiles embed.FS

type Store struct {
	pool *pgxpool.Pool
}

func Open(ctx context.Context, databaseURL string) (*Store, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, fmt.Errorf("create database pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("connect to database: %w", err)
	}

	store := &Store{pool: pool}
	if err := store.Migrate(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) Close() {
	s.pool.Close()
}

func (s *Store) Ready(ctx context.Context) error {
	return s.pool.Ping(ctx)
}

func (s *Store) Migrate(ctx context.Context) error {
	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()

	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", int64(775001)); err != nil {
		return err
	}
	defer conn.Exec(context.Background(), "SELECT pg_advisory_unlock($1)", int64(775001))

	if _, err := conn.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version TEXT PRIMARY KEY,
		applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	)`); err != nil {
		return fmt.Errorf("create migration table: %w", err)
	}

	entries, err := fs.ReadDir(migrationFiles, "migrations")
	if err != nil {
		return err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })

	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		var applied bool
		if err := conn.QueryRow(ctx,
			"SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = $1)",
			entry.Name(),
		).Scan(&applied); err != nil {
			return err
		}
		if applied {
			continue
		}

		sqlBytes, err := migrationFiles.ReadFile("migrations/" + entry.Name())
		if err != nil {
			return err
		}
		tx, err := conn.Begin(ctx)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, string(sqlBytes)); err != nil {
			tx.Rollback(ctx)
			return fmt.Errorf("apply migration %s: %w", entry.Name(), err)
		}
		if _, err := tx.Exec(ctx, "INSERT INTO schema_migrations (version) VALUES ($1)", entry.Name()); err != nil {
			tx.Rollback(ctx)
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) UpsertSources(ctx context.Context, sources []model.CloudSource) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	for _, source := range sources {
		if _, err := tx.Exec(ctx, `
			INSERT INTO cloud_sources (id, provider, name, scope_id, regions, enabled)
			VALUES ($1, $2, $3, $4, $5, $6)
			ON CONFLICT (id) DO UPDATE SET
				provider = EXCLUDED.provider,
				name = EXCLUDED.name,
				scope_id = EXCLUDED.scope_id,
				regions = EXCLUDED.regions,
				enabled = EXCLUDED.enabled,
				updated_at = NOW()`,
			source.ID, source.Provider, source.Name, source.ScopeID, source.Regions, source.Enabled,
		); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *Store) ListSources(ctx context.Context) ([]model.SourceSummary, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT s.id, s.provider, s.name, s.scope_id, s.regions, s.enabled,
			COUNT(c.id) FILTER (WHERE c.removed_at IS NULL),
			s.last_sync_status, s.last_sync_at, s.last_sync_error
		FROM cloud_sources s
		LEFT JOIN clusters c ON c.source_id = s.id
		GROUP BY s.id
		ORDER BY s.provider, s.name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	sources := make([]model.SourceSummary, 0)
	for rows.Next() {
		var source model.SourceSummary
		if err := rows.Scan(
			&source.ID, &source.Provider, &source.Name, &source.ScopeID, &source.Regions,
			&source.Enabled, &source.ClusterCount, &source.LastSyncStatus,
			&source.LastSyncAt, &source.LastSyncError,
		); err != nil {
			return nil, err
		}
		sources = append(sources, source)
	}
	return sources, rows.Err()
}

func (s *Store) ListClusters(ctx context.Context, filter model.ClusterFilter) (model.ClusterPage, error) {
	if filter.Page < 1 {
		filter.Page = 1
	}
	if filter.PageSize < 1 {
		filter.PageSize = 25
	}
	if filter.PageSize > 200 {
		filter.PageSize = 200
	}

	clauses := []string{"1=1"}
	args := make([]any, 0, 6)
	add := func(column, value string) {
		if value == "" {
			return
		}
		args = append(args, value)
		clauses = append(clauses, fmt.Sprintf("%s = $%d", column, len(args)))
	}
	add("c.provider", filter.Provider)
	add("c.source_id", filter.SourceID)
	add("c.status", filter.Status)
	if filter.Search != "" {
		args = append(args, "%"+strings.ToLower(filter.Search)+"%")
		clauses = append(clauses, fmt.Sprintf("LOWER(c.name) LIKE $%d", len(args)))
	}
	if !filter.IncludeRemoved {
		clauses = append(clauses, "c.removed_at IS NULL")
	}
	where := strings.Join(clauses, " AND ")

	var total int
	if err := s.pool.QueryRow(ctx, "SELECT COUNT(*) FROM clusters c WHERE "+where, args...).Scan(&total); err != nil {
		return model.ClusterPage{}, err
	}

	args = append(args, filter.PageSize, (filter.Page-1)*filter.PageSize)
	query := fmt.Sprintf(`
		SELECT c.id::text, c.source_id, s.name, c.provider, c.provider_resource_id,
			c.name, c.location, c.kubernetes_version, c.status, c.endpoint_access,
			c.node_count, c.metadata, c.first_seen_at, c.last_seen_at, c.updated_at, c.removed_at
		FROM clusters c
		JOIN cloud_sources s ON s.id = c.source_id
		WHERE %s
		ORDER BY c.name, c.provider, c.location
		LIMIT $%d OFFSET $%d`, where, len(args)-1, len(args))

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return model.ClusterPage{}, err
	}
	defer rows.Close()

	items := make([]model.Cluster, 0)
	for rows.Next() {
		var cluster model.Cluster
		var metadata []byte
		if err := rows.Scan(
			&cluster.ID, &cluster.SourceID, &cluster.SourceName, &cluster.Provider,
			&cluster.ProviderResourceID, &cluster.Name, &cluster.Location,
			&cluster.KubernetesVersion, &cluster.Status, &cluster.EndpointAccess,
			&cluster.NodeCount, &metadata, &cluster.FirstSeenAt, &cluster.LastSeenAt,
			&cluster.UpdatedAt, &cluster.RemovedAt,
		); err != nil {
			return model.ClusterPage{}, err
		}
		if err := json.Unmarshal(metadata, &cluster.Metadata); err != nil {
			return model.ClusterPage{}, err
		}
		items = append(items, cluster)
	}

	return model.ClusterPage{
		Items: items, Total: total, Page: filter.Page, PageSize: filter.PageSize,
	}, rows.Err()
}

func (s *Store) ListSyncRuns(ctx context.Context, limit int) ([]model.SyncRun, error) {
	if limit < 1 || limit > 200 {
		limit = 50
	}
	rows, err := s.pool.Query(ctx, `
		SELECT r.id::text, r.source_id, s.name, s.provider, r.trigger, r.status,
			r.discovered_count, r.changed_count, r.removed_count, r.error,
			r.queued_at, r.started_at, r.completed_at
		FROM sync_runs r
		JOIN cloud_sources s ON s.id = r.source_id
		ORDER BY r.queued_at DESC
		LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	runs := make([]model.SyncRun, 0)
	for rows.Next() {
		var run model.SyncRun
		if err := rows.Scan(
			&run.ID, &run.SourceID, &run.SourceName, &run.Provider, &run.Trigger,
			&run.Status, &run.DiscoveredCount, &run.ChangedCount, &run.RemovedCount,
			&run.Error, &run.QueuedAt, &run.StartedAt, &run.CompletedAt,
		); err != nil {
			return nil, err
		}
		runs = append(runs, run)
	}
	return runs, rows.Err()
}

func (s *Store) QueueSync(ctx context.Context, sourceID, trigger string) (model.SyncRun, error) {
	var run model.SyncRun
	err := s.pool.QueryRow(ctx, `
		INSERT INTO sync_runs (source_id, trigger)
		SELECT id, $2 FROM cloud_sources WHERE id = $1 AND enabled
		RETURNING id::text, source_id, trigger, status, queued_at`,
		sourceID, trigger,
	).Scan(&run.ID, &run.SourceID, &run.Trigger, &run.Status, &run.QueuedAt)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return model.SyncRun{}, ErrSyncAlreadyActive
		}
		return model.SyncRun{}, err
	}
	return run, nil
}

func (s *Store) QueueAll(ctx context.Context, trigger string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var locked bool
	if err := tx.QueryRow(ctx, "SELECT pg_try_advisory_xact_lock($1)", int64(775002)).Scan(&locked); err != nil {
		return err
	}
	if !locked {
		return tx.Commit(ctx)
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO sync_runs (source_id, trigger)
		SELECT s.id, $1
		FROM cloud_sources s
		WHERE s.enabled
		  AND NOT EXISTS (
			SELECT 1 FROM sync_runs r
			WHERE r.source_id = s.id AND r.status IN ('queued', 'running')
		  )`, trigger); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) ClaimNextSync(ctx context.Context) (*model.SyncRun, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	var run model.SyncRun
	err = tx.QueryRow(ctx, `
		SELECT id::text, source_id, trigger, status, queued_at
		FROM sync_runs
		WHERE status = 'queued'
		ORDER BY queued_at
		FOR UPDATE SKIP LOCKED
		LIMIT 1`).Scan(&run.ID, &run.SourceID, &run.Trigger, &run.Status, &run.QueuedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	if err := tx.QueryRow(ctx, `
		UPDATE sync_runs SET status = 'running', started_at = NOW()
		WHERE id = $1
		RETURNING started_at`, run.ID).Scan(&run.StartedAt); err != nil {
		return nil, err
	}
	run.Status = "running"
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &run, nil
}

func (s *Store) CompleteSync(ctx context.Context, run model.SyncRun, clusters []model.Cluster) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	seen := make([]string, 0, len(clusters))
	changed := 0
	for _, cluster := range clusters {
		metadata, err := json.Marshal(cluster.Metadata)
		if err != nil {
			return err
		}
		var wasChanged bool
		if err := tx.QueryRow(ctx, `
			INSERT INTO clusters (
				source_id, provider, provider_resource_id, name, location,
				kubernetes_version, status, endpoint_access, node_count, metadata
			) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
			ON CONFLICT (source_id, provider_resource_id) DO UPDATE SET
				name = EXCLUDED.name,
				location = EXCLUDED.location,
				kubernetes_version = EXCLUDED.kubernetes_version,
				status = EXCLUDED.status,
				endpoint_access = EXCLUDED.endpoint_access,
				node_count = EXCLUDED.node_count,
				metadata = EXCLUDED.metadata,
				last_seen_at = NOW(),
				updated_at = CASE WHEN
					(clusters.name, clusters.location, clusters.kubernetes_version,
					 clusters.status, clusters.endpoint_access, clusters.node_count, clusters.metadata)
					IS DISTINCT FROM
					(EXCLUDED.name, EXCLUDED.location, EXCLUDED.kubernetes_version,
					 EXCLUDED.status, EXCLUDED.endpoint_access, EXCLUDED.node_count, EXCLUDED.metadata)
					THEN NOW() ELSE clusters.updated_at END,
				removed_at = NULL
			RETURNING (xmax = 0) OR updated_at = NOW()`,
			run.SourceID, cluster.Provider, cluster.ProviderResourceID, cluster.Name,
			cluster.Location, cluster.KubernetesVersion, cluster.Status,
			cluster.EndpointAccess, cluster.NodeCount, metadata,
		).Scan(&wasChanged); err != nil {
			return err
		}
		if wasChanged {
			changed++
		}
		seen = append(seen, cluster.ProviderResourceID)
	}

	tag, err := tx.Exec(ctx, `
		UPDATE clusters SET removed_at = NOW(), updated_at = NOW()
		WHERE source_id = $1
		  AND removed_at IS NULL
		  AND NOT (provider_resource_id = ANY($2))`, run.SourceID, seen)
	if err != nil {
		return err
	}
	removed := int(tag.RowsAffected())

	if _, err := tx.Exec(ctx, `
		UPDATE sync_runs SET status = 'succeeded', discovered_count = $2,
			changed_count = $3, removed_count = $4, completed_at = NOW(), error = ''
		WHERE id = $1`,
		run.ID, len(clusters), changed, removed,
	); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE cloud_sources SET last_sync_status = 'succeeded',
			last_sync_at = NOW(), last_sync_error = '', updated_at = NOW()
		WHERE id = $1`, run.SourceID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) FailSync(ctx context.Context, run model.SyncRun, message string) error {
	_, err := s.pool.Exec(ctx, `
		WITH updated AS (
			UPDATE sync_runs SET status = 'failed', error = $2, completed_at = NOW()
			WHERE id = $1 RETURNING source_id
		)
		UPDATE cloud_sources SET last_sync_status = 'failed',
			last_sync_at = NOW(), last_sync_error = $2, updated_at = NOW()
		WHERE id = (SELECT source_id FROM updated)`, run.ID, message)
	return err
}
