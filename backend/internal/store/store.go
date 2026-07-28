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

func (s *Store) GetCluster(ctx context.Context, id string) (model.Cluster, error) {
	var cluster model.Cluster
	var metadata []byte
	err := s.pool.QueryRow(ctx, `
		SELECT c.id, c.source_id, s.name, c.provider, c.provider_resource_id, c.name,
			c.location, c.kubernetes_version, c.status, c.endpoint_access,
			c.node_count, c.metadata, c.first_seen_at, c.last_seen_at, c.updated_at, c.removed_at
		FROM clusters c
		JOIN cloud_sources s ON s.id = c.source_id
		WHERE c.id = $1`, id).Scan(
		&cluster.ID, &cluster.SourceID, &cluster.SourceName, &cluster.Provider,
		&cluster.ProviderResourceID, &cluster.Name, &cluster.Location,
		&cluster.KubernetesVersion, &cluster.Status, &cluster.EndpointAccess,
		&cluster.NodeCount, &metadata, &cluster.FirstSeenAt, &cluster.LastSeenAt,
		&cluster.UpdatedAt, &cluster.RemovedAt,
	)
	if err != nil {
		return model.Cluster{}, err
	}
	if err := json.Unmarshal(metadata, &cluster.Metadata); err != nil {
		return model.Cluster{}, err
	}
	return cluster, nil
}

func (s *Store) UpsertArgoAccess(
	ctx context.Context,
	access model.EncryptedArgoAccess,
) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO argo_cluster_access (
			source_id, provider_resource_id, server_url, username,
			password_ciphertext, password_nonce
		) VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (source_id, provider_resource_id) DO UPDATE SET
			server_url = EXCLUDED.server_url,
			username = EXCLUDED.username,
			password_ciphertext = EXCLUDED.password_ciphertext,
			password_nonce = EXCLUDED.password_nonce,
			updated_at = NOW()`,
		access.SourceID, access.ProviderResourceID, access.URL, access.Username,
		access.PasswordCiphertext, access.PasswordNonce,
	)
	return err
}

func (s *Store) GetArgoAccessByClusterID(
	ctx context.Context,
	clusterID string,
) (model.EncryptedArgoAccess, error) {
	var access model.EncryptedArgoAccess
	err := s.pool.QueryRow(ctx, `
		SELECT a.source_id, a.provider_resource_id, a.server_url, a.username,
			a.password_ciphertext, a.password_nonce
		FROM argo_cluster_access a
		JOIN clusters c
		  ON c.source_id = a.source_id
		 AND c.provider_resource_id = a.provider_resource_id
		WHERE c.id = $1`,
		clusterID,
	).Scan(
		&access.SourceID, &access.ProviderResourceID, &access.URL, &access.Username,
		&access.PasswordCiphertext, &access.PasswordNonce,
	)
	return access, err
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

func (s *Store) GetClustersByIDs(ctx context.Context, ids []string) ([]model.Cluster, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT c.id::text, c.source_id, s.name, c.provider, c.provider_resource_id,
			c.name, c.location, c.kubernetes_version, c.status, c.endpoint_access,
			c.node_count, c.metadata, c.first_seen_at, c.last_seen_at, c.updated_at, c.removed_at
		FROM clusters c
		JOIN cloud_sources s ON s.id = c.source_id
		WHERE c.id::text = ANY($1)
		ORDER BY c.name`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	clusters := make([]model.Cluster, 0, len(ids))
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
			return nil, err
		}
		if err := json.Unmarshal(metadata, &cluster.Metadata); err != nil {
			return nil, err
		}
		clusters = append(clusters, cluster)
	}
	return clusters, rows.Err()
}

func (s *Store) CreateApplicationOnboarding(
	ctx context.Context,
	onboarding model.ApplicationOnboarding,
	clusters []model.Cluster,
) (model.ApplicationOnboarding, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return model.ApplicationOnboarding{}, err
	}
	defer tx.Rollback(ctx)

	err = tx.QueryRow(ctx, `
		INSERT INTO application_onboardings (
			name, namespace, chart_repo_url, chart_name, chart_revision, values_digest,
			values_repository_url, values_repository_name, values_revision, values_commit_sha
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		RETURNING id::text, status, created_at, updated_at`,
		onboarding.Name, onboarding.Namespace, onboarding.ChartRepoURL,
		onboarding.ChartName, onboarding.ChartRevision, onboarding.ValuesDigest,
		onboarding.ValuesRepositoryURL, onboarding.ValuesRepositoryName,
		onboarding.ValuesRevision, onboarding.ValuesCommitSHA,
	).Scan(&onboarding.ID, &onboarding.Status, &onboarding.CreatedAt, &onboarding.UpdatedAt)
	if err != nil {
		return model.ApplicationOnboarding{}, err
	}

	onboarding.Targets = make([]model.ApplicationDeployment, 0, len(clusters))
	for _, cluster := range clusters {
		var target model.ApplicationDeployment
		err := tx.QueryRow(ctx, `
			INSERT INTO application_deployments (
				onboarding_id, cluster_id, cluster_name, region, source_id,
				provider_resource_id, argo_application
			) VALUES ($1, $2, $3, $4, $5, $6, $7)
			RETURNING id::text, onboarding_id::text, cluster_id::text, cluster_name,
				region, source_id, provider_resource_id, argo_application, status,
				sync_status, health_status, message, created_at, updated_at, completed_at`,
			onboarding.ID, cluster.ID, cluster.Name, cluster.Location, cluster.SourceID,
			cluster.ProviderResourceID, onboarding.Name,
		).Scan(
			&target.ID, &target.OnboardingID, &target.ClusterID, &target.ClusterName,
			&target.Region, &target.SourceID, &target.ProviderResourceID, &target.ArgoApplication,
			&target.Status, &target.SyncStatus, &target.HealthStatus, &target.Message,
			&target.CreatedAt, &target.UpdatedAt, &target.CompletedAt,
		)
		if err != nil {
			return model.ApplicationOnboarding{}, err
		}
		onboarding.Targets = append(onboarding.Targets, target)
	}
	if err := tx.Commit(ctx); err != nil {
		return model.ApplicationOnboarding{}, err
	}
	return onboarding, nil
}

func (s *Store) GetApplicationOnboarding(ctx context.Context, id string) (model.ApplicationOnboarding, error) {
	var onboarding model.ApplicationOnboarding
	err := s.pool.QueryRow(ctx, `
		SELECT id::text, name, namespace, chart_repo_url, chart_name, chart_revision,
			values_digest, values_repository_url, values_repository_name,
			values_revision, values_commit_sha, status, created_at, updated_at, completed_at
		FROM application_onboardings
		WHERE id::text = $1`, id).Scan(
		&onboarding.ID, &onboarding.Name, &onboarding.Namespace,
		&onboarding.ChartRepoURL, &onboarding.ChartName, &onboarding.ChartRevision,
		&onboarding.ValuesDigest, &onboarding.ValuesRepositoryURL,
		&onboarding.ValuesRepositoryName, &onboarding.ValuesRevision,
		&onboarding.ValuesCommitSHA, &onboarding.Status, &onboarding.CreatedAt,
		&onboarding.UpdatedAt, &onboarding.CompletedAt,
	)
	if err != nil {
		return model.ApplicationOnboarding{}, err
	}
	targets, err := s.listApplicationDeployments(ctx, onboarding.ID)
	if err != nil {
		return model.ApplicationOnboarding{}, err
	}
	onboarding.Targets = targets
	return onboarding, nil
}

func (s *Store) ListApplicationOnboardings(
	ctx context.Context,
	filter model.ApplicationOnboardingFilter,
) (model.ApplicationOnboardingPage, error) {
	if filter.Page < 1 {
		filter.Page = 1
	}
	if filter.PageSize < 1 {
		filter.PageSize = 20
	}
	if filter.PageSize > 200 {
		filter.PageSize = 200
	}

	clauses := []string{"1=1"}
	args := make([]any, 0, 3)
	if filter.Search != "" {
		args = append(args, "%"+strings.ToLower(filter.Search)+"%")
		clauses = append(clauses, fmt.Sprintf(
			"(LOWER(name) LIKE $%d OR LOWER(namespace) LIKE $%d)", len(args), len(args),
		))
	}
	if filter.Status != "" {
		args = append(args, filter.Status)
		clauses = append(clauses, fmt.Sprintf("status = $%d", len(args)))
	}
	where := strings.Join(clauses, " AND ")

	page := model.ApplicationOnboardingPage{
		Items: make([]model.ApplicationOnboarding, 0),
		Page:  filter.Page, PageSize: filter.PageSize,
	}
	if err := s.pool.QueryRow(
		ctx, "SELECT COUNT(*) FROM application_onboardings WHERE "+where, args...,
	).Scan(&page.Total); err != nil {
		return model.ApplicationOnboardingPage{}, err
	}

	args = append(args, filter.PageSize, (filter.Page-1)*filter.PageSize)
	rows, err := s.pool.Query(ctx, fmt.Sprintf(`
		SELECT id::text, name, namespace, chart_repo_url, chart_name, chart_revision,
			values_digest, values_repository_url, values_repository_name,
			values_revision, values_commit_sha, status, created_at, updated_at, completed_at
		FROM application_onboardings
		WHERE %s
		ORDER BY created_at DESC
		LIMIT $%d OFFSET $%d`, where, len(args)-1, len(args)), args...)
	if err != nil {
		return model.ApplicationOnboardingPage{}, err
	}
	defer rows.Close()

	for rows.Next() {
		var onboarding model.ApplicationOnboarding
		if err := rows.Scan(
			&onboarding.ID, &onboarding.Name, &onboarding.Namespace,
			&onboarding.ChartRepoURL, &onboarding.ChartName, &onboarding.ChartRevision,
			&onboarding.ValuesDigest, &onboarding.ValuesRepositoryURL,
			&onboarding.ValuesRepositoryName, &onboarding.ValuesRevision,
			&onboarding.ValuesCommitSHA, &onboarding.Status, &onboarding.CreatedAt,
			&onboarding.UpdatedAt, &onboarding.CompletedAt,
		); err != nil {
			return model.ApplicationOnboardingPage{}, err
		}
		page.Items = append(page.Items, onboarding)
	}
	if err := rows.Err(); err != nil {
		return model.ApplicationOnboardingPage{}, err
	}
	for i := range page.Items {
		targets, err := s.listApplicationDeployments(ctx, page.Items[i].ID)
		if err != nil {
			return model.ApplicationOnboardingPage{}, err
		}
		page.Items[i].Targets = targets
	}
	return page, nil
}

func (s *Store) listApplicationDeployments(
	ctx context.Context,
	onboardingID string,
) ([]model.ApplicationDeployment, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, onboarding_id::text, cluster_id::text, cluster_name,
			region, source_id, provider_resource_id, argo_application, status,
			sync_status, health_status, message, created_at, updated_at, completed_at
		FROM application_deployments
		WHERE onboarding_id::text = $1
		ORDER BY cluster_name`, onboardingID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	targets := make([]model.ApplicationDeployment, 0)
	for rows.Next() {
		var target model.ApplicationDeployment
		if err := rows.Scan(
			&target.ID, &target.OnboardingID, &target.ClusterID, &target.ClusterName,
			&target.Region, &target.SourceID, &target.ProviderResourceID, &target.ArgoApplication,
			&target.Status, &target.SyncStatus, &target.HealthStatus, &target.Message,
			&target.CreatedAt, &target.UpdatedAt, &target.CompletedAt,
		); err != nil {
			return nil, err
		}
		targets = append(targets, target)
	}
	return targets, rows.Err()
}

func (s *Store) ListActiveApplicationDeployments(
	ctx context.Context,
) ([]model.ApplicationDeployment, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, onboarding_id::text, cluster_id::text, cluster_name,
			region, source_id, provider_resource_id, argo_application, status,
			sync_status, health_status, message, created_at, updated_at, completed_at
		FROM application_deployments
		WHERE status IN ('creating', 'progressing')
		ORDER BY updated_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	targets := make([]model.ApplicationDeployment, 0)
	for rows.Next() {
		var target model.ApplicationDeployment
		if err := rows.Scan(
			&target.ID, &target.OnboardingID, &target.ClusterID, &target.ClusterName,
			&target.Region, &target.SourceID, &target.ProviderResourceID, &target.ArgoApplication,
			&target.Status, &target.SyncStatus, &target.HealthStatus, &target.Message,
			&target.CreatedAt, &target.UpdatedAt, &target.CompletedAt,
		); err != nil {
			return nil, err
		}
		targets = append(targets, target)
	}
	return targets, rows.Err()
}

func (s *Store) UpdateApplicationDeployment(
	ctx context.Context,
	id, status, syncStatus, healthStatus, message string,
) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var onboardingID string
	err = tx.QueryRow(ctx, `
		UPDATE application_deployments
		SET status = $2, sync_status = $3, health_status = $4, message = $5,
			updated_at = NOW(),
			completed_at = CASE WHEN $2 IN ('healthy', 'failed') THEN NOW() ELSE NULL END
		WHERE id::text = $1
		RETURNING onboarding_id::text`,
		id, status, syncStatus, healthStatus, message,
	).Scan(&onboardingID)
	if err != nil {
		return err
	}

	_, err = tx.Exec(ctx, `
		WITH totals AS (
			SELECT COUNT(*) AS total,
				COUNT(*) FILTER (WHERE status = 'healthy') AS healthy,
				COUNT(*) FILTER (WHERE status = 'failed') AS failed
			FROM application_deployments
			WHERE onboarding_id::text = $1
		), next AS (
			SELECT CASE
				WHEN healthy = total THEN 'healthy'
				WHEN failed = total THEN 'failed'
				WHEN healthy + failed = total AND failed > 0 THEN 'partial'
				ELSE 'progressing'
			END AS status
			FROM totals
		)
		UPDATE application_onboardings
		SET status = next.status, updated_at = NOW(),
			completed_at = CASE WHEN next.status IN ('healthy', 'failed', 'partial')
				THEN NOW() ELSE NULL END
		FROM next
		WHERE id::text = $1`, onboardingID)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}
