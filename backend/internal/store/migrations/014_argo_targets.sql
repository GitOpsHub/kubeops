-- Argo CD targets configured directly in the database (Neon), so a new
-- cluster's Argo CD access can be added without editing argo-targets.yaml
-- and redeploying. Mirrors argo_cluster_access's ciphertext/nonce columns
-- and (source_id, provider_resource_id) composite key.
CREATE TABLE argo_targets (
    source_id TEXT NOT NULL REFERENCES cloud_sources(id) ON DELETE CASCADE,
    provider_resource_id TEXT NOT NULL,
    server_url TEXT NOT NULL,
    token_ciphertext BYTEA NOT NULL,
    token_nonce BYTEA NOT NULL,
    ca_cert TEXT NOT NULL DEFAULT '',
    ui_url TEXT NOT NULL DEFAULT '',
    username TEXT NOT NULL DEFAULT '',
    password_ciphertext BYTEA,
    password_nonce BYTEA,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (source_id, provider_resource_id)
);
