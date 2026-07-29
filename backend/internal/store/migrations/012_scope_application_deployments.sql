-- A release context owns its own Kubernetes namespace and Argo CD application.
-- This keeps dev, qa, and prod onboardings of the same logical application from
-- overwriting one another.
WITH scoped AS (
    SELECT
        id,
        environment || '-' || region AS scope,
        63 - LENGTH(environment || '-' || region) - 1 AS max_base_length
    FROM application_onboardings
)
UPDATE application_onboardings AS onboarding
SET namespace =
    REGEXP_REPLACE(LEFT(onboarding.namespace, scoped.max_base_length), '-+$', '') ||
    '-' || scoped.scope
FROM scoped
WHERE onboarding.id = scoped.id
  AND onboarding.namespace NOT LIKE '%-' || scoped.scope;

WITH scoped AS (
    SELECT
        id,
        name,
        environment || '-' || region AS scope,
        63 - LENGTH(environment || '-' || region) - 1 AS max_base_length
    FROM application_onboardings
)
UPDATE application_deployments AS deployment
SET argo_application =
    REGEXP_REPLACE(LEFT(scoped.name, scoped.max_base_length), '-+$', '') ||
    '-' || scoped.scope
FROM scoped
WHERE deployment.onboarding_id = scoped.id
  AND deployment.argo_application NOT LIKE '%-' || scoped.scope;
