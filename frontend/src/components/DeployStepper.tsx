import { Fragment } from 'react'
import type { ApplicationDeployment } from '../api/onboarding'

/**
 * Where the rollout stands, derived entirely from target counts — no stage is
 * ever shown as reached unless the targets say so.
 *
 * The stages mirror what actually happens: Argo applications are created, they
 * reconcile, they report synced, and their workloads come up healthy.
 */

const stages = ['Created', 'Reconciling', 'Synced', 'Healthy'] as const

type Props = {
  targets: ApplicationDeployment[]
}

function stageIndex(targets: ApplicationDeployment[]) {
  if (targets.length === 0) return 0
  if (targets.every((target) => target.status === 'healthy')) return 3
  if (targets.every((target) => target.syncStatus.toLowerCase() === 'synced')) return 2
  if (targets.some((target) => target.status === 'progressing' || target.status === 'creating')) {
    return 1
  }
  return 0
}

export function DeployStepper({ targets }: Props) {
  const current = stageIndex(targets)
  const failed = targets.filter((target) => target.status === 'failed').length
  const healthy = targets.filter((target) => target.status === 'healthy').length

  return (
    <div className="deploy-stepper">
      {stages.map((stage, index) => {
        // A failure stops the run where it stands: later stages stay untouched
        // rather than being painted as reached.
        const isFailed = failed > 0 && index === current
        // Reaching the last stage means the rollout landed, so it settles as
        // done rather than pulsing as though work were still in flight.
        const settled = index < current || (index === current && current === stages.length - 1)
        const state = isFailed ? 'failed' : settled ? 'done' : index === current ? 'current' : 'ahead'

        return (
          <Fragment key={stage}>
            {index > 0 && <span className="deploy-step-line" aria-hidden="true" />}
            <span className={`deploy-step deploy-step--${state}`}>
              <span className="deploy-step-dot" aria-hidden="true" />
              {stage}
            </span>
          </Fragment>
        )
      })}
      <span className="quiet-note deploy-step-tally">
        {healthy}/{targets.length} healthy
        {failed > 0 && ` · ${failed} failed`}
      </span>
    </div>
  )
}
