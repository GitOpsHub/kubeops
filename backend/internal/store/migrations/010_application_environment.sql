ALTER TABLE application_onboardings
    ADD COLUMN environment TEXT NOT NULL DEFAULT 'development';
