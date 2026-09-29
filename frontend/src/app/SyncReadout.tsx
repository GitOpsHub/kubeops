import type { SyncRun } from '../api/inventory'
import { relativeTime } from '../lib/format'
import { syncTriggerLabel } from '../lib/providers'

function statusLabel(run: SyncRun | null) {
  if (!run) return 'Awaiting sync'
  return run.status === 'succeeded' ? 'Synced' : `Sync ${run.status}`
}

type Props = {
  run: SyncRun | null
  unavailable: boolean
  /** The shell's automatic sync is discovering stale sources right now. */
  syncing?: boolean
}

/**
 * The fleet's heartbeat: how the most recent discovery run went and when. It
 * deliberately carries no live-region role — it refreshes on a timer and
 * would otherwise talk over whatever the operator is doing.
 */
export function SyncReadout({ run, unavailable, syncing = false }: Props) {
  const tone = syncing ? 'running' : unavailable ? 'idle' : (run?.status ?? 'idle')
  const title = syncing
    ? 'Syncing sources…'
    : unavailable && !run
      ? 'Sync status unavailable'
      : statusLabel(run)
  return (
    <div className="sync-readout" title={run ? `${run.sourceName} · ${syncTriggerLabel(run.trigger)}` : undefined}>
      <span className={`sync-dot sync-dot--${tone}`} aria-hidden="true" />
      <div className="sync-readout-copy">
        <strong>{title}</strong>
        <span>
          {run ? relativeTime(run.completedAt ?? run.queuedAt) : 'No activity yet'} · auto-sync on
        </span>
      </div>
    </div>
  )
}
