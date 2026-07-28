import type { ApplicationDeployment } from '../api/onboarding'

type Props = {
  target: ApplicationDeployment
}

/**
 * Renders one Argo CD deployment target. The link is served by the backend's Argo CD
 * proxy, which attaches the API token, so this panel never handles Argo CD
 * credentials at all.
 */
export function DeploymentTargetPanel({ target }: Props) {
  return (
    <article className="target-panel" aria-label={`Deployment target ${target.clusterName}`}>
      <header>
        <div>
          <strong>{target.clusterName}</strong>
          <span>{target.region || 'no region'}</span>
        </div>
        <span className={`deployment-pill deployment-pill--${target.status}`}>
          {target.status}
        </span>
      </header>

      <dl className="target-facts">
        <div>
          <dt>Argo application</dt>
          <dd className="mono">{target.argoApplication}</dd>
        </div>
        <div>
          <dt>Sync status</dt>
          <dd>{target.syncStatus || 'Unknown'}</dd>
        </div>
        <div>
          <dt>Health</dt>
          <dd>{target.healthStatus || 'Unknown'}</dd>
        </div>
      </dl>

      {target.message && (
        <p className="target-message" role="status">
          {target.message}
        </p>
      )}

      {target.argoApplicationUrl ? (
        <div className="target-actions">
          <a href={target.argoApplicationUrl} target="_blank" rel="noreferrer">
            Open in Argo CD
          </a>
        </div>
      ) : (
        <p className="target-unavailable">
          Argo CD UI access is not configured for this cluster.
        </p>
      )}
    </article>
  )
}
