-- An audit trail of actions taken through KubeOps, so an application's
-- timeline can tell "via KubeOps" apart from Argo CD's own automated syncs.
-- result records whether KubeOps's request was accepted, not how the
-- deployment that followed turned out; Argo CD history answers that.
CREATE TABLE application_operations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    onboarding_id UUID NOT NULL REFERENCES application_onboardings(id) ON DELETE CASCADE,
    target_id UUID REFERENCES application_deployments(id) ON DELETE CASCADE,
    kind TEXT NOT NULL
        CHECK (kind IN ('sync', 'dry-run', 'rollback', 'terminate', 'scale', 'offboard')),
    params JSONB NOT NULL DEFAULT '{}',
    result TEXT NOT NULL CHECK (result IN ('succeeded', 'failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX application_operations_recent_idx
    ON application_operations (onboarding_id, created_at DESC);
