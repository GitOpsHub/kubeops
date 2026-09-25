import type { ArgoAppStatus } from '../../api/argo'
import type { ApplicationDeployment } from '../../api/onboarding'
import { ChevronRightIcon } from '../../components/icons'
import { StatusDot } from '../../components/ui/StatusDot'
import { ElapsedTime } from './ElapsedTime'
import { currentPhaseLabel, isInFlightPhase } from './operation-phases'
import './argo.css'

type Props = {
  targets: ApplicationDeployment[]
  statuses: Record<string, ArgoAppStatus | undefined>
  /** Opens the Sync tab on the given target. */
  onOpen: (targetId: string) => void
}

/**
 * A strip that stays in view while any cluster is mid-sync, so progress is
 * visible from every tab. It renders nothing otherwise; its entrance is the
 * only motion, and a poll that finds the same sync running does not replay it.
 */
export function OperationBar({ targets, statuses, onOpen }: Props) {
  const running = targets.filter((target) => isInFlightPhase(statuses[target.id]?.operation?.phase))
  if (running.length === 0) return null

  const first = running[0]
  const operation = statuses[first.id]!.operation!
  const verb =
    operation.phase === 'Terminating' ? 'Terminating' : operation.dryRun ? 'Dry run' : 'Syncing'
  const who = running.length === 1 ? first.clusterName : `${running.length} clusters`

  return (
    <section className="op-bar" aria-label="Sync in progress" data-tone="info">
      <button
        type="button"
        className="op-bar-button"
        onClick={() => onOpen(first.id)}
        aria-label={`${verb} ${who}. View sync progress`}
      >
        <StatusDot tone={operation.phase === 'Terminating' ? 'warn' : 'info'} inFlight />
        <span className="op-bar-text">
          <strong>
            {verb} {who}
          </strong>
          {running.length === 1 && (
            <>
              <span aria-hidden="true">·</span>
              <span>{currentPhaseLabel(operation)}</span>
            </>
          )}
          <span aria-hidden="true">·</span>
          <ElapsedTime startedAt={operation.startedAt} running />
        </span>
        <span className="op-bar-cta" aria-hidden="true">
          View progress
          <ChevronRightIcon />
        </span>
      </button>
    </section>
  )
}
