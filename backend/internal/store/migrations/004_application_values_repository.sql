ALTER TABLE application_onboardings
    ADD COLUMN values_repository_url TEXT NOT NULL DEFAULT '',
    ADD COLUMN values_repository_name TEXT NOT NULL DEFAULT '',
    ADD COLUMN values_revision TEXT NOT NULL DEFAULT '',
    ADD COLUMN values_commit_sha TEXT NOT NULL DEFAULT '';
