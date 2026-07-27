CREATE TABLE application_onboardings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    namespace TEXT NOT NULL,
    chart_repo_url TEXT NOT NULL,
    chart_name TEXT NOT NULL,
    chart_revision TEXT NOT NULL,
    values_digest TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'progressing'
        CHECK (status IN ('progressing', 'healthy', 'partial', 'failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX application_onboardings_recent_idx
    ON application_onboardings (created_at DESC);

CREATE TABLE application_deployments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    onboarding_id UUID NOT NULL REFERENCES application_onboardings(id) ON DELETE CASCADE,
    cluster_id UUID NOT NULL REFERENCES clusters(id),
    cluster_name TEXT NOT NULL,
    source_id TEXT NOT NULL,
    provider_resource_id TEXT NOT NULL,
    argo_application TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'creating'
        CHECK (status IN ('creating', 'progressing', 'healthy', 'failed')),
    sync_status TEXT NOT NULL DEFAULT 'Unknown',
    health_status TEXT NOT NULL DEFAULT 'Unknown',
    message TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    UNIQUE (onboarding_id, cluster_id)
);

CREATE INDEX application_deployments_active_idx
    ON application_deployments (updated_at)
    WHERE status IN ('creating', 'progressing');
