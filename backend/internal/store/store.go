package store

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/GitOpsHub/kubeops/backend/internal/config"
	"github.com/GitOpsHub/kubeops/backend/internal/model"
	"github.com/GitOpsHub/kubeops/backend/internal/secure"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrSyncAlreadyActive = errors.New("sync already active")

// ErrOnboardingExists reports that an application with the same name and
// namespace is already onboarded. The unique index enforces it, so a request
// that passes the service's own check can still land here under a race.
var ErrOnboardingExists = errors.New("application is already onboarded")

// PostgreSQL's unique_violation SQLSTATE.
const uniqueViolation = "23505"

//go:embed migrations/*.sql
var migrationFiles embed.FS

type Store struct {
	pool *pgxpool.Pool
}

// Options tunes the connection pool for where the backend runs.
type Options struct {
	// MaxConns caps the pool; zero means defaultMaxConns. Every serverless
	// instance holds its own pool, so the database sees this multiplied by the
	// number of warm instances.
	MaxConns int32
	// Pooler is "transaction" when DATABASE_URL points at a transaction-mode
	// connection pooler. A host containing "-pooler" (Neon's convention) is
	// detected without it.
	Pooler string
	// MigrationURL, when set, is a direct (unpooled) connection used only for
	// migrations, such as Neon's DATABASE_URL_UNPOOLED.
	MigrationURL string
}

const defaultMaxConns = 4

func Open(ctx context.Context, databaseURL string) (*Store, error) {
	return OpenWithOptions(ctx, databaseURL, Options{})
}

func OpenWithOptions(ctx context.Context, databaseURL string, options Options) (*Store, error) {
	poolConfig, err := poolConfig(databaseURL, options)
	if err != nil {
		return nil, err
	}
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return nil, fmt.Errorf("create database pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("connect to database: %w", err)
	}

	store := &Store{pool: pool}
	if options.MigrationURL != "" {
		err = migrateUnpooled(ctx, options.MigrationURL)
	} else {
		err = store.Migrate(ctx)
	}
	if err != nil {
		pool.Close()
		return nil, err
	}
	return store, nil
}

func poolConfig(databaseURL string, options Options) (*pgxpool.Config, error) {
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse database URL: %w", err)
	}
	config.MaxConns = defaultMaxConns
	if options.MaxConns > 0 {
		config.MaxConns = options.MaxConns
	}
	// A suspended serverless instance cannot close its connections, so they are
	// kept short-lived rather than left for the server to reap.
	config.MaxConnIdleTime = 30 * time.Second
	config.MaxConnLifetime = 5 * time.Minute
	if strings.EqualFold(options.Pooler, "transaction") ||
		strings.Contains(config.ConnConfig.Host, "-pooler") {
		// A transaction pooler hands each transaction a different server
		// connection, so pgx's default named prepared statements collide or go
		// missing. Describe-only caching uses the unnamed statement instead.
		config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeCacheDescribe
	}
	return config, nil
}

func migrateUnpooled(ctx context.Context, migrationURL string) error {
	conn, err := pgx.Connect(ctx, migrationURL)
	if err != nil {
		return fmt.Errorf("connect to database for migrations: %w", err)
	}
	defer conn.Close(context.WithoutCancel(ctx))
	return migrate(ctx, conn)
}

func (s *Store) Close() {
	s.pool.Close()
}

func (s *Store) Ready(ctx context.Context) error {
	return s.pool.Ping(ctx)
}

func (s *Store) Migrate(ctx context.Context) error {
	return migrate(ctx, s.pool)
}

// migrationLockTimeout bounds how long a cold start waits for another
// instance's migrations before giving up, rather than hanging until the
// platform kills the function.
const migrationLockTimeout = "30s"

// migrate applies every pending migration in one transaction guarded by a
// transaction-scoped advisory lock. A session lock (pg_advisory_lock) is not
// safe behind a transaction pooler: the unlock can run on a different server
// connection, leaving the lock held forever. The transaction lock is released
// by COMMIT or ROLLBACK on whichever connection holds it.
func migrate(ctx context.Context, db interface {
	Begin(context.Context) (pgx.Tx, error)
}) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))

	if _, err := tx.Exec(ctx, "SET LOCAL lock_timeout = '"+migrationLockTimeout+"'"); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", int64(775001)); err != nil {
		return fmt.Errorf("acquire migration lock: %w", err)
	}
	// The lock timeout guards only the advisory lock; migrations themselves may
	// need to wait for locks held by a live instance's queries.
	if _, err := tx.Exec(ctx, "SET LOCAL lock_timeout = 0"); err != nil {
		return err
	}

	if _, err := tx.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
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
		if err := tx.QueryRow(ctx,
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
		if _, err := tx.Exec(ctx, string(sqlBytes)); err != nil {
			return fmt.Errorf("apply migration %s: %w", entry.Name(), err)
		}
		if _, err := tx.Exec(ctx, "INSERT INTO schema_migrations (version) VALUES ($1)", entry.Name()); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// validUUID reports whether id can be compared against a UUID column.
// Comparing col = $1 (rather than col::text = $1) lets PostgreSQL use the
// index, but a malformed id then fails the whole query with
// invalid_text_representation instead of matching nothing. Callers screen ids
// here and report a malformed one as not found. The length check rejects the
// urn: and braced forms uuid.Parse accepts but PostgreSQL does not.
func validUUID(id string) bool {
	if len(id) != 36 {
		return false
	}
	_, err := uuid.Parse(id)
	return err == nil
}

func (s *Store) UpsertSources(ctx context.Context, sources []model.CloudSource) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	for _, source := range sources {
		regions := source.Regions
		if regions == nil {
			regions = []string{}
		}
		contexts := source.Contexts
		if contexts == nil {
			contexts = []string{}
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO cloud_sources (
				id, provider, name, scope_id, regions, enabled,
				role_arn, impersonate_service_account, workload_identity_provider,
				tenant_id, client_id, kubeconfig_path, contexts
			)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
			ON CONFLICT (id) DO UPDATE SET
				provider = EXCLUDED.provider,
				name = EXCLUDED.name,
				scope_id = EXCLUDED.scope_id,
				regions = EXCLUDED.regions,
				enabled = EXCLUDED.enabled,
				role_arn = EXCLUDED.role_arn,
				impersonate_service_account = EXCLUDED.impersonate_service_account,
				workload_identity_provider = EXCLUDED.workload_identity_provider,
				tenant_id = EXCLUDED.tenant_id,
				client_id = EXCLUDED.client_id,
				kubeconfig_path = EXCLUDED.kubeconfig_path,
				contexts = EXCLUDED.contexts,
				updated_at = NOW()`,
			source.ID, source.Provider, source.Name, source.ScopeID, regions, source.Enabled,
			source.RoleARN, source.ImpersonateServiceAccount, source.WorkloadIdentityProvider,
			source.TenantID, source.ClientID, source.KubeconfigPath, contexts,
		); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// ListCloudSourcesConfig returns every cloud_sources row as a full
// model.CloudSource, including the federation columns that ListSources /
// SourceSummary deliberately omit from API responses. It is used at startup
// to merge database-managed sources into the config loaded from YAML/env, so
// a cloud source can be added or updated by inserting a row directly instead
// of editing cloud-sources.yaml and redeploying.
func (s *Store) ListCloudSourcesConfig(ctx context.Context) ([]model.CloudSource, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, provider, name, scope_id, regions, enabled,
			role_arn, impersonate_service_account, workload_identity_provider,
			tenant_id, client_id, kubeconfig_path, contexts
		FROM cloud_sources
		ORDER BY provider, name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	sources := make([]model.CloudSource, 0)
	for rows.Next() {
		var source model.CloudSource
		if err := rows.Scan(
			&source.ID, &source.Provider, &source.Name, &source.ScopeID, &source.Regions,
			&source.Enabled, &source.RoleARN, &source.ImpersonateServiceAccount,
			&source.WorkloadIdentityProvider, &source.TenantID, &source.ClientID,
			&source.KubeconfigPath, &source.Contexts,
		); err != nil {
			return nil, err
		}
		sources = append(sources, source)
	}
	return sources, rows.Err()
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
	if filter.SourceIDs != nil {
		if len(filter.SourceIDs) == 0 {
			clauses = append(clauses, "FALSE")
		} else {
			args = append(args, filter.SourceIDs)
			clauses = append(clauses, fmt.Sprintf("c.source_id = ANY($%d)", len(args)))
		}
	}
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
	if !validUUID(id) {
		return model.Cluster{}, pgx.ErrNoRows
	}
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
	if !validUUID(clusterID) {
		return access, pgx.ErrNoRows
	}
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

// UpsertArgoTarget writes one argo_targets row. Token and password are
// already encrypted by the caller (see secure.Encrypt) -- this method never
// sees plaintext.
func (s *Store) UpsertArgoTarget(ctx context.Context, target model.EncryptedArgoTarget) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO argo_targets (
			source_id, provider_resource_id, server_url,
			token_ciphertext, token_nonce, ca_cert,
			ui_url, username, password_ciphertext, password_nonce
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		ON CONFLICT (source_id, provider_resource_id) DO UPDATE SET
			server_url = EXCLUDED.server_url,
			token_ciphertext = EXCLUDED.token_ciphertext,
			token_nonce = EXCLUDED.token_nonce,
			ca_cert = EXCLUDED.ca_cert,
			ui_url = EXCLUDED.ui_url,
			username = EXCLUDED.username,
			password_ciphertext = EXCLUDED.password_ciphertext,
			password_nonce = EXCLUDED.password_nonce,
			updated_at = NOW()`,
		target.SourceID, target.ProviderResourceID, target.ServerURL,
		target.TokenCiphertext, target.TokenNonce, target.CACert,
		target.UIURL, target.Username, target.PasswordCiphertext, target.PasswordNonce,
	)
	return err
}

// ListArgoTargets reads every argo_targets row and decrypts it into a
// config.ArgoTarget -- the same type argo-targets.yaml produces -- so
// callers can merge database-managed targets into cfg.Onboarding.ArgoTargets
// without any change to how targets are consumed downstream (Argo client
// construction, the reverse proxy, ProxyID). A target's CA certificate, if
// present, is written to a temp file since Vercel's filesystem is read-only
// outside /tmp; ArgoTarget.CAFile already expects a file path.
//
// key must be the same ARGO_CREDENTIAL_ENCRYPTION_KEY used to encrypt these
// rows (see backend/cmd/seed-argo-target). A nil key with existing rows is a
// configuration error, not silently skipped, since it means kubeops cannot
// use Argo CD targets it knows the database has.
func (s *Store) ListArgoTargets(ctx context.Context, key []byte) ([]config.ArgoTarget, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT source_id, provider_resource_id, server_url,
			token_ciphertext, token_nonce, ca_cert,
			ui_url, username, password_ciphertext, password_nonce
		FROM argo_targets
		ORDER BY source_id, provider_resource_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	targets := make([]config.ArgoTarget, 0)
	for rows.Next() {
		var (
			row                               model.EncryptedArgoTarget
			passwordCiphertext, passwordNonce []byte
		)
		if err := rows.Scan(
			&row.SourceID, &row.ProviderResourceID, &row.ServerURL,
			&row.TokenCiphertext, &row.TokenNonce, &row.CACert,
			&row.UIURL, &row.Username, &passwordCiphertext, &passwordNonce,
		); err != nil {
			return nil, err
		}

		if len(key) == 0 {
			return nil, fmt.Errorf(
				"argo_targets has a row for %s/%s but ARGO_CREDENTIAL_ENCRYPTION_KEY is not set",
				row.SourceID, row.ProviderResourceID,
			)
		}
		token, err := secure.Decrypt(key, row.TokenCiphertext, row.TokenNonce)
		if err != nil {
			return nil, fmt.Errorf("decrypt Argo CD token for %s/%s: %w", row.SourceID, row.ProviderResourceID, err)
		}

		target := config.ArgoTarget{
			SourceID:           row.SourceID,
			ProviderResourceID: row.ProviderResourceID,
			ServerURL:          row.ServerURL,
			Token:              string(token),
			UIURL:              row.UIURL,
			Username:           row.Username,
		}

		if row.CACert != "" {
			caFile, err := os.CreateTemp("", "argo-target-ca-*.pem")
			if err != nil {
				return nil, fmt.Errorf("write CA certificate for %s/%s: %w", row.SourceID, row.ProviderResourceID, err)
			}
			if _, err := caFile.WriteString(row.CACert); err != nil {
				caFile.Close()
				return nil, fmt.Errorf("write CA certificate for %s/%s: %w", row.SourceID, row.ProviderResourceID, err)
			}
			if err := caFile.Close(); err != nil {
				return nil, fmt.Errorf("write CA certificate for %s/%s: %w", row.SourceID, row.ProviderResourceID, err)
			}
			target.CAFile = caFile.Name()
		}

		if len(passwordCiphertext) > 0 {
			password, err := secure.Decrypt(key, passwordCiphertext, passwordNonce)
			if err != nil {
				return nil, fmt.Errorf("decrypt Argo CD UI password for %s/%s: %w", row.SourceID, row.ProviderResourceID, err)
			}
			target.Password = string(password)
		}

		targets = append(targets, target)
	}
	return targets, rows.Err()
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
		if errors.As(err, &pgErr) && pgErr.Code == uniqueViolation {
			return model.SyncRun{}, ErrSyncAlreadyActive
		}
		return model.SyncRun{}, err
	}
	return run, nil
}

// abandonedSyncMessage marks a run whose owner stopped reporting. On Vercel
// that is a function killed at its duration limit, which never reaches
// FailSync; elsewhere a crashed or restarted process.
const abandonedSyncMessage = "sync abandoned: it did not finish within the sync timeout"

// StartSync creates a run that is already owned by the current request. Unlike
// QueueSync, it cannot be claimed by a background worker between the insert and
// provider discovery, which makes manual syncs safe on request-driven runtimes.
//
// A run for this source still active after staleAfter is failed first. A warm
// serverless instance never passes through startup recovery again, so without
// this a run killed at the platform's time limit would keep answering every
// later sync of its source with ErrSyncAlreadyActive.
func (s *Store) StartSync(
	ctx context.Context,
	sourceID, trigger string,
	staleAfter time.Duration,
) (model.SyncRun, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return model.SyncRun{}, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))

	if err := failStaleSyncs(ctx, tx, staleAfter, abandonedSyncMessage, sourceID); err != nil {
		return model.SyncRun{}, err
	}
	var run model.SyncRun
	err = tx.QueryRow(ctx, `
		INSERT INTO sync_runs (source_id, trigger, status, started_at)
		SELECT id, $2, 'running', NOW() FROM cloud_sources WHERE id = $1 AND enabled
		RETURNING id::text, source_id, trigger, status, queued_at, started_at`,
		sourceID, trigger,
	).Scan(&run.ID, &run.SourceID, &run.Trigger, &run.Status, &run.QueuedAt, &run.StartedAt)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == uniqueViolation {
			return model.SyncRun{}, ErrSyncAlreadyActive
		}
		return model.SyncRun{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return model.SyncRun{}, err
	}
	return run, nil
}

// failStaleSyncs fails queued or running runs older than staleAfter, for one
// source or, with sourceID empty, for all of them. Only stale runs are touched:
// local and deployed instances can share one database, and failing a live run
// owned by another instance would let a second sync of the same source start.
func failStaleSyncs(
	ctx context.Context,
	db interface {
		Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	},
	staleAfter time.Duration,
	message string,
	sourceID string,
) error {
	_, err := db.Exec(ctx, `
		WITH interrupted AS (
			UPDATE sync_runs
			SET status = 'failed', error = $1, completed_at = NOW()
			WHERE ($3 = '' OR source_id = $3)
			  AND ((status = 'running' AND started_at < NOW() - make_interval(secs => $2))
			    OR (status = 'queued' AND queued_at < NOW() - make_interval(secs => $2)))
			RETURNING source_id
		)
		UPDATE cloud_sources
		SET last_sync_status = 'failed', last_sync_at = NOW(),
			last_sync_error = $1, updated_at = NOW()
		WHERE id IN (SELECT source_id FROM interrupted)`,
		message, staleAfter.Seconds(), sourceID)
	return err
}

// RecoverStaleSyncs fails runs left behind by an instance that stopped
// before finishing them. Instances with background workers call it at startup
// and on every scheduler tick; request-driven instances at cold start, since
// they have no worker to claim a queued run and it would otherwise block its
// source indefinitely.
func (s *Store) RecoverStaleSyncs(ctx context.Context, staleAfter time.Duration) error {
	return failStaleSyncs(ctx, s.pool, staleAfter, abandonedSyncMessage, "")
}

func (s *Store) QueueAll(ctx context.Context, trigger string, sourceIDs []string) error {
	if len(sourceIDs) == 0 {
		return nil
	}
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
		WHERE s.enabled AND s.id = ANY($2)
		  AND NOT EXISTS (
			SELECT 1 FROM sync_runs r
			WHERE r.source_id = s.id AND r.status IN ('queued', 'running')
		  )`, trigger, sourceIDs); err != nil {
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
	valid := make([]string, 0, len(ids))
	for _, id := range ids {
		if validUUID(id) {
			valid = append(valid, id)
		}
	}
	rows, err := s.pool.Query(ctx, `
		SELECT c.id::text, c.source_id, s.name, c.provider, c.provider_resource_id,
			c.name, c.location, c.kubernetes_version, c.status, c.endpoint_access,
			c.node_count, c.metadata, c.first_seen_at, c.last_seen_at, c.updated_at, c.removed_at
		FROM clusters c
		JOIN cloud_sources s ON s.id = c.source_id
		WHERE c.id = ANY($1::uuid[])
		ORDER BY c.name`, valid)
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
	regionValues map[string]bool,
) (model.ApplicationOnboarding, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return model.ApplicationOnboarding{}, err
	}
	defer tx.Rollback(ctx)

	err = tx.QueryRow(ctx, `
		INSERT INTO application_onboardings (
			name, namespace, environment, region, chart_repo_url, chart_name, chart_revision, image, values_digest,
			values_repository_url, values_repository_clone_url, values_repository_name,
			values_revision, values_commit_sha
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
		RETURNING id::text, status, created_at, updated_at`,
		onboarding.Name, onboarding.Namespace, onboarding.Environment, onboarding.Region, onboarding.ChartRepoURL,
		onboarding.ChartName, onboarding.ChartRevision, onboarding.Image, onboarding.ValuesDigest,
		onboarding.ValuesRepositoryURL, onboarding.ValuesRepositoryCloneURL,
		onboarding.ValuesRepositoryName, onboarding.ValuesRevision, onboarding.ValuesCommitSHA,
	).Scan(&onboarding.ID, &onboarding.Status, &onboarding.CreatedAt, &onboarding.UpdatedAt)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == uniqueViolation &&
			pgErr.ConstraintName == "application_onboardings_active_name_idx" {
			return model.ApplicationOnboarding{}, ErrOnboardingExists
		}
		return model.ApplicationOnboarding{}, err
	}

	onboarding.Targets = make([]model.ApplicationDeployment, 0, len(clusters))
	for _, cluster := range clusters {
		var target model.ApplicationDeployment
		deploymentRegion := onboarding.Region
		if deploymentRegion == "" {
			deploymentRegion = cluster.Location
		}
		err := tx.QueryRow(ctx, `
			INSERT INTO application_deployments (
				onboarding_id, cluster_id, cluster_name, region, source_id,
				provider_resource_id, argo_application, has_region_values
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			RETURNING id::text, onboarding_id::text, cluster_id::text, cluster_name,
				region, source_id, provider_resource_id, argo_application,
				has_region_values, status,
				sync_status, health_status, message, created_at, updated_at, completed_at,
				attempt_started_at`,
			onboarding.ID, cluster.ID, cluster.Name, deploymentRegion, cluster.SourceID,
			cluster.ProviderResourceID,
			scopedApplicationName(onboarding.Name, onboarding.Environment, onboarding.Region),
			regionValues[deploymentRegion],
		).Scan(
			&target.ID, &target.OnboardingID, &target.ClusterID, &target.ClusterName,
			&target.Region, &target.SourceID, &target.ProviderResourceID, &target.ArgoApplication,
			&target.HasRegionValues, &target.Status, &target.SyncStatus,
			&target.HealthStatus, &target.Message,
			&target.CreatedAt, &target.UpdatedAt, &target.CompletedAt,
			&target.AttemptStartedAt,
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

func scopedApplicationName(name, environment, region string) string {
	if environment == "" || region == "" {
		return name
	}
	scope := environment + "-" + region
	if strings.HasSuffix(name, "-"+scope) {
		return name
	}
	return name + "-" + scope
}

// ActiveApplicationOnboardingID returns the id of the onboarding that currently
// owns this name and namespace, or an empty string when the name is free.
// Offboarded records do not own their name, so a removed application can be
// onboarded again.
func (s *Store) ActiveApplicationOnboardingID(
	ctx context.Context,
	name string,
	namespace string,
) (string, error) {
	var id string
	err := s.pool.QueryRow(ctx, `
		SELECT id::text FROM application_onboardings
		WHERE name = $1 AND namespace = $2 AND status <> 'offboarded'`,
		name, namespace,
	).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return id, nil
}

func (s *Store) GetApplicationOnboarding(ctx context.Context, id string) (model.ApplicationOnboarding, error) {
	if !validUUID(id) {
		return model.ApplicationOnboarding{}, pgx.ErrNoRows
	}
	var onboarding model.ApplicationOnboarding
	err := s.pool.QueryRow(ctx, `
		SELECT id::text, name, namespace, environment, region, chart_repo_url, chart_name, chart_revision,
			image, values_digest, values_repository_url, values_repository_clone_url, values_repository_name,
			values_revision, values_commit_sha, status, created_at, updated_at, completed_at
		FROM application_onboardings
		WHERE id = $1`, id).Scan(
		&onboarding.ID, &onboarding.Name, &onboarding.Namespace, &onboarding.Environment, &onboarding.Region,
		&onboarding.ChartRepoURL, &onboarding.ChartName, &onboarding.ChartRevision,
		&onboarding.Image, &onboarding.ValuesDigest, &onboarding.ValuesRepositoryURL,
		&onboarding.ValuesRepositoryCloneURL, &onboarding.ValuesRepositoryName, &onboarding.ValuesRevision,
		&onboarding.ValuesCommitSHA, &onboarding.Status, &onboarding.CreatedAt,
		&onboarding.UpdatedAt, &onboarding.CompletedAt,
	)
	if err != nil {
		return model.ApplicationOnboarding{}, err
	}
	targets, err := s.listApplicationDeployments(ctx, []string{onboarding.ID})
	if err != nil {
		return model.ApplicationOnboarding{}, err
	}
	onboarding.Targets = targets[onboarding.ID]
	if onboarding.Targets == nil {
		onboarding.Targets = make([]model.ApplicationDeployment, 0)
	}
	return onboarding, nil
}

func (s *Store) UpdateApplicationOnboardingValues(
	ctx context.Context,
	id string,
	valuesDigest string,
	valuesCommitSHA string,
) error {
	if !validUUID(id) {
		return pgx.ErrNoRows
	}
	result, err := s.pool.Exec(ctx, `
		UPDATE application_onboardings
		SET values_digest = $2, values_commit_sha = $3, updated_at = NOW()
		WHERE id = $1`,
		id, valuesDigest, valuesCommitSHA,
	)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return nil
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
	} else {
		// An offboarded application has no cluster resources left, so it drops out of
		// the default listing. The record and its GitHub values are kept on purpose,
		// and selecting the status explicitly still brings it back.
		clauses = append(clauses, "status <> 'offboarded'")
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
		SELECT id::text, name, namespace, environment, region, chart_repo_url, chart_name, chart_revision,
			image, values_digest, values_repository_url, values_repository_clone_url, values_repository_name,
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
			&onboarding.ID, &onboarding.Name, &onboarding.Namespace, &onboarding.Environment, &onboarding.Region,
			&onboarding.ChartRepoURL, &onboarding.ChartName, &onboarding.ChartRevision,
			&onboarding.Image, &onboarding.ValuesDigest, &onboarding.ValuesRepositoryURL,
			&onboarding.ValuesRepositoryCloneURL, &onboarding.ValuesRepositoryName,
			&onboarding.ValuesRevision,
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
	ids := make([]string, len(page.Items))
	for i := range page.Items {
		ids[i] = page.Items[i].ID
	}
	targets, err := s.listApplicationDeployments(ctx, ids)
	if err != nil {
		return model.ApplicationOnboardingPage{}, err
	}
	for i := range page.Items {
		page.Items[i].Targets = targets[page.Items[i].ID]
		if page.Items[i].Targets == nil {
			page.Items[i].Targets = make([]model.ApplicationDeployment, 0)
		}
	}
	return page, nil
}

// listApplicationDeployments loads the targets of every given onboarding in one
// query, keyed by onboarding id, so a page of applications costs one round trip
// rather than one per row.
func (s *Store) listApplicationDeployments(
	ctx context.Context,
	onboardingIDs []string,
) (map[string][]model.ApplicationDeployment, error) {
	targets := make(map[string][]model.ApplicationDeployment, len(onboardingIDs))
	if len(onboardingIDs) == 0 {
		return targets, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, onboarding_id::text, cluster_id::text, cluster_name,
			region, source_id, provider_resource_id, argo_application,
			has_region_values, status,
			sync_status, health_status, message, created_at, updated_at, completed_at,
			attempt_started_at
		FROM application_deployments
		WHERE onboarding_id = ANY($1::uuid[])
		ORDER BY onboarding_id, cluster_name`, onboardingIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var target model.ApplicationDeployment
		if err := rows.Scan(
			&target.ID, &target.OnboardingID, &target.ClusterID, &target.ClusterName,
			&target.Region, &target.SourceID, &target.ProviderResourceID, &target.ArgoApplication,
			&target.HasRegionValues, &target.Status, &target.SyncStatus,
			&target.HealthStatus, &target.Message,
			&target.CreatedAt, &target.UpdatedAt, &target.CompletedAt,
			&target.AttemptStartedAt,
		); err != nil {
			return nil, err
		}
		targets[target.OnboardingID] = append(targets[target.OnboardingID], target)
	}
	return targets, rows.Err()
}

func (s *Store) ListActiveApplicationDeployments(
	ctx context.Context,
) ([]model.ApplicationDeployment, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, onboarding_id::text, cluster_id::text, cluster_name,
			region, source_id, provider_resource_id, argo_application,
			has_region_values, status,
			sync_status, health_status, message, created_at, updated_at, completed_at,
			attempt_started_at
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
			&target.HasRegionValues, &target.Status, &target.SyncStatus,
			&target.HealthStatus, &target.Message,
			&target.CreatedAt, &target.UpdatedAt, &target.CompletedAt,
			&target.AttemptStartedAt,
		); err != nil {
			return nil, err
		}
		targets = append(targets, target)
	}
	return targets, rows.Err()
}

// RestartApplicationDeploymentAttempts opens a fresh deployment-timeout window for
// every target of an onboarding. Sync calls it so a target that already exhausted
// its window is judged on the new attempt instead of staying failed forever.
func (s *Store) RestartApplicationDeploymentAttempts(
	ctx context.Context,
	onboardingID string,
) error {
	if !validUUID(onboardingID) {
		return nil
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE application_deployments
		SET attempt_started_at = NOW()
		WHERE onboarding_id = $1`, onboardingID)
	return err
}

func (s *Store) UpdateApplicationDeployment(
	ctx context.Context,
	id, status, syncStatus, healthStatus, message string,
) error {
	if !validUUID(id) {
		return pgx.ErrNoRows
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// Targets are created in parallel and therefore finish together. Lock the
	// parent before touching this deployment so concurrent updates serialise here:
	// each transaction then recomputes the totals below from a snapshot that
	// already contains every sibling update that committed before it. Without this
	// the last writer can persist a total it computed before its sibling committed,
	// leaving the onboarding stuck on 'progressing' after every target is terminal.
	var onboardingID string
	err = tx.QueryRow(ctx, `
		SELECT o.id::text
		FROM application_onboardings o
		JOIN application_deployments d ON d.onboarding_id = o.id
		WHERE d.id = $1
		FOR UPDATE OF o`, id).Scan(&onboardingID)
	if err != nil {
		return err
	}

	if _, err = tx.Exec(ctx, `
		UPDATE application_deployments
		SET status = $2, sync_status = $3, health_status = $4, message = $5,
			updated_at = NOW(),
			completed_at = CASE WHEN $2 IN ('healthy', 'failed', 'offboarded')
				THEN NOW() ELSE NULL END
		WHERE id = $1`,
		id, status, syncStatus, healthStatus, message,
	); err != nil {
		return err
	}

	_, err = tx.Exec(ctx, `
		WITH totals AS (
			SELECT COUNT(*) AS total,
				COUNT(*) FILTER (WHERE status = 'healthy') AS healthy,
				COUNT(*) FILTER (WHERE status = 'failed') AS failed,
				COUNT(*) FILTER (WHERE status = 'offboarded') AS offboarded
			FROM application_deployments
			WHERE onboarding_id = $1
		), next AS (
			SELECT CASE
				WHEN offboarded = total THEN 'offboarded'
				WHEN healthy = total THEN 'healthy'
				WHEN failed = total THEN 'failed'
				WHEN healthy + failed + offboarded = total
					AND (failed > 0 OR offboarded > 0) THEN 'partial'
				ELSE 'progressing'
			END AS status
			FROM totals
		)
		UPDATE application_onboardings
		SET status = next.status, updated_at = NOW(),
			completed_at = CASE WHEN next.status IN ('healthy', 'failed', 'partial', 'offboarded')
				THEN NOW() ELSE NULL END
		FROM next
		WHERE id = $1`, onboardingID)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}
