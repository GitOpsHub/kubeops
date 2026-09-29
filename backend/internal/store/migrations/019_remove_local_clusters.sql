-- Clusters discovered by the removed local providers (docker, minikube) are
-- marked removed. Nothing can reach their Argo CD any more, and offboarding
-- trusts the inventory's removal, so without this an application still
-- deployed to one of them could never be offboarded.
UPDATE clusters SET removed_at = NOW(), updated_at = NOW()
WHERE provider IN ('docker', 'minikube') AND removed_at IS NULL;
