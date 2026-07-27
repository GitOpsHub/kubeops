CREATE TABLE argo_cluster_access (
    source_id TEXT NOT NULL REFERENCES cloud_sources(id) ON DELETE CASCADE,
    provider_resource_id TEXT NOT NULL,
    server_url TEXT NOT NULL,
    username TEXT NOT NULL,
    password_ciphertext BYTEA NOT NULL,
    password_nonce BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (source_id, provider_resource_id)
);
