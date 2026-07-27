CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE cloud_sources (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('aws', 'gcp', 'azure')),
    name TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    regions TEXT[] NOT NULL DEFAULT '{}',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    last_sync_status TEXT NOT NULL DEFAULT 'never',
    last_sync_at TIMESTAMPTZ,
    last_sync_error TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE clusters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id TEXT NOT NULL REFERENCES cloud_sources(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('aws', 'gcp', 'azure')),
    provider_resource_id TEXT NOT NULL,
    name TEXT NOT NULL,
    location TEXT NOT NULL,
    kubernetes_version TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'unknown',
    endpoint_access TEXT NOT NULL DEFAULT 'unknown'
        CHECK (endpoint_access IN ('public', 'private', 'both', 'unknown')),
    node_count INTEGER,
    metadata JSONB NOT NULL DEFAULT '{}',
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    removed_at TIMESTAMPTZ,
    UNIQUE (source_id, provider_resource_id)
);

CREATE INDEX clusters_provider_idx ON clusters (provider) WHERE removed_at IS NULL;
CREATE INDEX clusters_source_idx ON clusters (source_id) WHERE removed_at IS NULL;
CREATE INDEX clusters_status_idx ON clusters (status) WHERE removed_at IS NULL;
CREATE INDEX clusters_name_search_idx ON clusters (LOWER(name));

CREATE TABLE sync_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id TEXT NOT NULL REFERENCES cloud_sources(id) ON DELETE CASCADE,
    trigger TEXT NOT NULL CHECK (trigger IN ('startup', 'scheduled', 'manual')),
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
    discovered_count INTEGER NOT NULL DEFAULT 0,
    changed_count INTEGER NOT NULL DEFAULT 0,
    removed_count INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '',
    queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX sync_runs_one_active_per_source
    ON sync_runs (source_id) WHERE status IN ('queued', 'running');
CREATE INDEX sync_runs_recent_idx ON sync_runs (queued_at DESC);
