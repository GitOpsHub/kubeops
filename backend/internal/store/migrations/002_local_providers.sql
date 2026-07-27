ALTER TABLE cloud_sources
    DROP CONSTRAINT cloud_sources_provider_check;

ALTER TABLE cloud_sources
    ADD CONSTRAINT cloud_sources_provider_check
    CHECK (provider IN ('aws', 'gcp', 'azure', 'docker', 'minikube'));

ALTER TABLE clusters
    DROP CONSTRAINT clusters_provider_check;

ALTER TABLE clusters
    ADD CONSTRAINT clusters_provider_check
    CHECK (provider IN ('aws', 'gcp', 'azure', 'docker', 'minikube'));
