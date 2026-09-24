import type { ApplicationDeployment } from '../../api/onboarding'
import { DeploymentTargetLogo } from '../../components/DeploymentTargetLogo'
import { StateDelta } from '../../components/StateDelta'
import type { ApplicationEndpoint } from './application-detail'

type Props = {
  namespace: string
  targets: ApplicationDeployment[]
  endpoints: ApplicationEndpoint[]
}

/**
 * Where this release runs and how to reach it. Argo CD links go through the
 * backend proxy, which attaches the API token, so this panel never handles
 * Argo CD credentials.
 */
export function TargetsPanel({ namespace, targets, endpoints }: Props) {
  return (
    <div className="targets-panel">
      <section className="targets-section" aria-label="Deployment clusters">
        <h2 className="kicker">Targets</h2>
        {targets.length === 0 ? (
          <span className="subtle">No clusters assigned</span>
        ) : (
          <div className="target-list">
            {targets.map((target) => (
              <article
                className="target-card"
                key={target.id}
                aria-label={`Deployment target ${target.clusterName}`}
              >
                <DeploymentTargetLogo target={target} />
                <div className="target-card-copy">
                  <strong className="truncate">{target.clusterName}</strong>
                  <span className="mono truncate">{namespace}</span>
                </div>
                <StateDelta
                  syncStatus={target.syncStatus}
                  healthStatus={target.healthStatus}
                  compact
                />
                {target.argoApplicationUrl && (
                  <a
                    className="target-card-argo"
                    href={target.argoApplicationUrl}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open ${target.clusterName} in Argo CD`}
                    title="Open in Argo CD"
                  >
                    ↗
                  </a>
                )}
                {target.message && <p className="target-card-message">{target.message}</p>}
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="targets-section" aria-label="Application URLs">
        <h2 className="kicker">Endpoints</h2>
        {endpoints.length > 0 ? (
          <nav className="endpoint-links" aria-label="Application endpoints">
            {endpoints.map((endpoint) => (
              <a
                key={endpoint.url}
                href={endpoint.url}
                target="_blank"
                rel="noreferrer"
                title={`Open ${endpoint.label}`}
              >
                {endpoint.label}
                <span aria-hidden="true">↗</span>
              </a>
            ))}
          </nav>
        ) : (
          <span className="subtle">No external URL reported</span>
        )}
      </section>
    </div>
  )
}
