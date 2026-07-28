-- Onboarding the same application twice created a second record that pointed at
-- the very same Argo CD application: the Argo application is named after the
-- onboarding, so two records for one name/namespace both claimed one real
-- application on every shared cluster. Both then reported the same status, and
-- offboarding either one deleted the application the other still claimed.
--
-- Existing duplicates are merged rather than dropped. Deployments the surviving
-- record does not already track are reassigned to it, so a duplicate that
-- covered a cluster the survivor missed keeps its Argo application tracked;
-- only the rows that alias a cluster the survivor already owns are discarded.
-- The newest record survives because it reflects the most recent intent.

WITH ranked AS (
    SELECT
        id,
        name,
        namespace,
        ROW_NUMBER() OVER (
            PARTITION BY name, namespace ORDER BY created_at DESC, id
        ) AS position
    FROM application_onboardings
    WHERE status <> 'offboarded'
),
survivors AS (
    SELECT id, name, namespace FROM ranked WHERE position = 1
),
duplicates AS (
    SELECT ranked.id, survivors.id AS survivor_id
    FROM ranked
    JOIN survivors USING (name, namespace)
    WHERE ranked.position > 1
)
UPDATE application_deployments AS deployment
SET onboarding_id = duplicates.survivor_id
FROM duplicates
WHERE deployment.onboarding_id = duplicates.id
  AND NOT EXISTS (
      SELECT 1
      FROM application_deployments AS kept
      WHERE kept.onboarding_id = duplicates.survivor_id
        AND kept.cluster_id = deployment.cluster_id
  );

-- Whatever is left on a duplicate now aliases a cluster the survivor tracks, so
-- the record and its remaining deployments go (deployments cascade).
WITH ranked AS (
    SELECT
        id,
        ROW_NUMBER() OVER (
            PARTITION BY name, namespace ORDER BY created_at DESC, id
        ) AS position
    FROM application_onboardings
    WHERE status <> 'offboarded'
)
DELETE FROM application_onboardings
WHERE id IN (SELECT id FROM ranked WHERE position > 1);

-- Offboarded records are excluded so a name can be onboarded again after it has
-- been removed from its clusters, and so the history of past onboardings is kept.
CREATE UNIQUE INDEX application_onboardings_active_name_idx
    ON application_onboardings (name, namespace)
    WHERE status <> 'offboarded';
