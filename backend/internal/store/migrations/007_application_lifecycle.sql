ALTER TABLE application_onboardings
    DROP CONSTRAINT application_onboardings_status_check;

ALTER TABLE application_onboardings
    ADD CONSTRAINT application_onboardings_status_check
    CHECK (status IN ('progressing', 'healthy', 'partial', 'failed', 'offboarded'));

ALTER TABLE application_deployments
    DROP CONSTRAINT application_deployments_status_check;

ALTER TABLE application_deployments
    ADD CONSTRAINT application_deployments_status_check
    CHECK (status IN ('creating', 'progressing', 'healthy', 'failed', 'offboarded'));

ALTER TABLE application_deployments
    ADD COLUMN has_region_values BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE application_onboardings
    ADD COLUMN values_repository_clone_url TEXT NOT NULL DEFAULT '';
