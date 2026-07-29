ALTER TABLE application_onboardings
    ADD COLUMN region TEXT NOT NULL DEFAULT 'us-east-1';

UPDATE application_onboardings
SET environment = CASE environment
    WHEN 'development' THEN 'dev'
    WHEN 'staging' THEN 'qa'
    WHEN 'production' THEN 'prod'
    ELSE environment
END;
