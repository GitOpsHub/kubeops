import { Link } from 'react-router-dom'
import type { ArgoAppStatus } from '../../api/argo'
import type { ApplicationDeployment } from '../../api/onboarding'
import { DeploymentTargetLogo } from '../../components/DeploymentTargetLogo'
import { LogsIcon } from '../../components/icons'
import { StateDelta } from '../../components/StateDelta'
import { StatusDot } from '../../components/ui/StatusDot'
import { healthTone } from '../../lib/status'
import { logsPageHref } from '../log-viewer/logs-link'
import {
  currentPhaseLabel,
  isInFlightPhase,
  operationOutcome,
  operationProgress,
} from '../argo/operation-phases'
import type { ApplicationEndpoint } from './application-detail'
import { useChangeFlash } from './useChangeFlash'

type Props = {
  onboardingId: string
  namespace: string
  targets: ApplicationDeployment[]
  endpoints: ApplicationEndpoint[]
  statuses: Record<string, ArgoAppStatus | undefined>
  /** Opens the Sync tab on a target. */
  onOpenSync: (targetId: string) => void
}

/**
 * Where this release runs and how to reach it. Argo CD links go through the
 * backend proxy, which attaches the API token, so this panel never handles
 * Argo CD credentials.
 */
export function TargetsPanel({
  onboardingId,
  namespace,
  targets,
  endpoints,
  statuses,
  onOpenSync,
}: Props) {
  return (
    <div className="targets-panel">
      <section className="targets-section" aria-label="Deployment clusters">
        <h2 className="kicker">Targets</h2>
        {targets.length === 0 ? (
          <span className="subtle">No clusters assigned</span>
        ) : (
          <div className="target-list">
            {targets.map((target) => (
              <TargetCard
                key={target.id}
                onboardingId={onboardingId}
                namespace={namespace}
                target={target}
                status={statuses[target.id]}
                onOpenSync={() => onOpenSync(target.id)}
              />
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

function TargetCard({
  onboardingId,
  namespace,
  target,
  status,
  onOpenSync,
}: {
  onboardingId: string
  namespace: string
  target: ApplicationDeployment
  status: ArgoAppStatus | undefined
  onOpenSync: () => void
}) {
  const flashing = useChangeFlash(target.healthStatus)
  const operation = status?.operation
  const running = isInFlightPhase(operation?.phase)
  const lastFailed =
    operation && !running && ['failed', 'terminated'].includes(operationOutcome(operation))

  return (
    <article
      className={flashing ? 'target-card is-flashing' : 'target-card'}
      data-tone={healthTone(target.healthStatus)}
      aria-label={`Deployment target ${target.clusterName}`}
    >
      <DeploymentTargetLogo target={target} />
      <div className="target-card-copy">
        <strong className="truncate">{target.clusterName}</strong>
        <span className="mono truncate">{namespace}</span>
      </div>
      <StateDelta syncStatus={target.syncStatus} healthStatus={target.healthStatus} compact />
      <Link
        className="target-card-action"
        to={logsPageHref(onboardingId, target.id)}
        aria-label={`Logs for ${target.clusterName}`}
        title="Open logs"
      >
        <LogsIcon aria-hidden="true" />
      </Link>
      {target.argoApplicationUrl && (
        <a
          className="target-card-action"
          href={target.argoApplicationUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${target.clusterName} in Argo CD`}
          title="Open in Argo CD"
        >
          ↗
        </a>
      )}
      {operation && (running || lastFailed) && (
        <button
          type="button"
          className="target-card-op"
          data-tone={running ? (operation.phase === 'Terminating' ? 'warn' : 'info') : 'err'}
          onClick={onOpenSync}
          aria-label={
            running
              ? `${operation.dryRun ? 'Dry run' : 'Sync'} running on ${target.clusterName}: ${currentPhaseLabel(operation)}. View progress`
              : `Last sync on ${target.clusterName} ${operationOutcome(operation)}. View details`
          }
        >
          <StatusDot tone={running ? 'info' : 'err'} inFlight={running} size="sm" />
          <span className="target-card-op-label">
            {running
              ? `${operation.dryRun ? 'Dry run' : 'Syncing'} · ${currentPhaseLabel(operation)}`
              : `Last sync ${operationOutcome(operation)}`}
          </span>
          {running && (
            <span className="target-card-progress" aria-hidden="true">
              <span style={{ transform: `scaleX(${operationProgress(operation)})` }} />
            </span>
          )}
        </button>
      )}
      {target.message && <p className="target-card-message">{target.message}</p>}
    </article>
  )
}
