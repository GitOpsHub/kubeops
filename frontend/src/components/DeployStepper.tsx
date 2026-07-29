import type { ApplicationDeployment } from '../api/onboarding'
import { StatusBadge } from './StatusBadge'

/**
 * One application-level state derived from every deployment target. Operators
 * need the outcome and its coverage, not a synthetic sequence of lifecycle steps.
 */

type Props = {
  targets: ApplicationDeployment[]
}

export function DeployStepper({ targets }: Props) {
  const failed = targets.filter((target) => target.status === 'failed').length
  const healthy = targets.filter((target) => target.status === 'healthy').length
  const state =
    targets.length === 0
      ? 'pending'
      : failed === targets.length
        ? 'failed'
        : failed > 0
          ? 'partial'
          : healthy === targets.length
            ? 'healthy'
            : 'progressing'
  const progress = targets.length === 0 ? 0 : Math.round((healthy / targets.length) * 100)

  return (
    <div className="application-state" aria-label={`Application state: ${state}`}>
      <div className="application-state-heading">
        <p className="section-label">Application state</p>
        <StatusBadge status={state} />
      </div>
      <div
        className="application-state-progress"
        role="progressbar"
        aria-label="Healthy deployment targets"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
      >
        <span style={{ width: `${progress}%` }} />
      </div>
      <span className="quiet-note">
        {healthy} of {targets.length} targets ready
        {failed > 0 && ` · ${failed} failed`}
      </span>
    </div>
  )
}
