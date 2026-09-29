-- The UI now refreshes stale sources itself while KubeOps is open, recording
-- those runs with trigger 'auto'.
ALTER TABLE sync_runs DROP CONSTRAINT IF EXISTS sync_runs_trigger_check;
ALTER TABLE sync_runs ADD CONSTRAINT sync_runs_trigger_check
    CHECK (trigger IN ('startup', 'scheduled', 'manual', 'cron', 'auto'));

-- Local kubeconfig discovery (docker, minikube) is gone. Their rows are kept,
-- since application deployments may still reference their clusters, but no
-- longer count as enabled sources.
UPDATE cloud_sources SET enabled = false, updated_at = NOW()
WHERE provider IN ('docker', 'minikube') AND enabled;
