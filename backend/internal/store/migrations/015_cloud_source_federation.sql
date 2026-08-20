-- Federation identifiers (not credentials -- no static keys/tokens here) for
-- cloud sources managed directly in the database instead of cloud-sources.yaml.
ALTER TABLE cloud_sources
    ADD COLUMN role_arn TEXT NOT NULL DEFAULT '',
    ADD COLUMN impersonate_service_account TEXT NOT NULL DEFAULT '',
    ADD COLUMN workload_identity_provider TEXT NOT NULL DEFAULT '',
    ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '',
    ADD COLUMN client_id TEXT NOT NULL DEFAULT '',
    ADD COLUMN kubeconfig_path TEXT NOT NULL DEFAULT '',
    ADD COLUMN contexts TEXT[] NOT NULL DEFAULT '{}';
