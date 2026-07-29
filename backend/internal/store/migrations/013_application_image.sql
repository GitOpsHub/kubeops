-- Keep the resolved container image with the onboarding so the release header
-- can show the deployed artifact without depending on a live Argo CD response.
ALTER TABLE application_onboardings
    ADD COLUMN image TEXT NOT NULL DEFAULT '';
