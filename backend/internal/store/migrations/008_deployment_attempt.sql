-- The deployment timeout used to be measured from created_at, which is never
-- reset. Every target older than the timeout was therefore failed by the
-- reconciler before it ever read Argo CD, so a re-sync could not recover it.
-- attempt_started_at marks when the current deployment attempt began and is
-- reset by each sync. Existing rows adopt the migration time so targets that
-- were stuck past the timeout get a fresh window.
ALTER TABLE application_deployments
    ADD COLUMN attempt_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
