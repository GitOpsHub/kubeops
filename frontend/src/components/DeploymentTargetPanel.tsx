import type { ApplicationDeployment } from '../api/onboarding'
import { StateDelta } from './StateDelta'
import { StatusBadge } from './StatusBadge'

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
        <StatusBadge status={target.status} />
      </header>

      <StateDelta syncStatus={target.syncStatus} healthStatus={target.healthStatus} />

      <dl className="target-argo-name">
        <dt>Argo application</dt>
        <dd>{target.argoApplication}</dd>
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
