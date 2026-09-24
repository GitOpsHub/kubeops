-- The scheduled-sync endpoint records its runs with trigger 'cron', which the
-- original CHECK did not allow, so every Vercel Cron invocation failed on insert.
-- 001_initial.sql declared the check inline, so PostgreSQL named it
-- sync_runs_trigger_check.
ALTER TABLE sync_runs DROP CONSTRAINT IF EXISTS sync_runs_trigger_check;
ALTER TABLE sync_runs ADD CONSTRAINT sync_runs_trigger_check
    CHECK (trigger IN ('startup', 'scheduled', 'manual', 'cron'));
