package store

import (
	"context"
	"errors"

	"github.com/GitOpsHub/kubeops/backend/internal/model"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// undefinedTable is Postgres's SQLSTATE for a relation that does not exist.
// fleet_registry and cluster_argocd_details are owned by kubespin, not by
// kubeops's own migrations, so a deployment that never runs kubespin simply
// lacks these tables — that must not break Argo CD access for clusters
// discovered through the ordinary cloud-provider sync.
const undefinedTable = "42P01"

// GetKubespinArgoDetails resolves the Argo CD connection kubespin captured for
// a cloud-discovered cluster, matched by cluster name against
// fleet_registry.cluster_id. Clusters remain discovered exclusively through
// the existing cloud-provider polling; kubespin's tables are consulted only to
// find Argo CD access for a cluster kubeops already knows about. A cluster
// whose kubespin phase is not 'ready' (decommissioned, or missing entirely)
// returns pgx.ErrNoRows, the same as no match at all.
func (s *Store) GetKubespinArgoDetails(ctx context.Context, clusterName string) (model.KubespinArgoCDDetails, error) {
	var details model.KubespinArgoCDDetails
	err := s.pool.QueryRow(ctx, `
		SELECT a.cluster_id, a.kube_context, a.argocd_endpoint, a.argocd_username,
			a.argocd_password, a.captured_at, a.updated_at
		FROM cluster_argocd_details a
		JOIN fleet_registry f ON f.cluster_id = a.cluster_id
		WHERE a.cluster_id = $1 AND f.phase = 'ready'`,
		clusterName,
	).Scan(
		&details.ClusterID, &details.KubeContext, &details.Endpoint, &details.Username,
		&details.Password, &details.CapturedAt, &details.UpdatedAt,
	)
	if err != nil {
		if isUndefinedTable(err) {
			return model.KubespinArgoCDDetails{}, pgx.ErrNoRows
		}
		return model.KubespinArgoCDDetails{}, err
	}
	return details, nil
}

func isUndefinedTable(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == undefinedTable
}
