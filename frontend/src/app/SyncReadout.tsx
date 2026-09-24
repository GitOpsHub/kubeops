import type { SyncRun } from '../api/inventory'
import { StatusDot } from '../components/ui/StatusDot'
import { relativeTime } from '../lib/format'

function statusLabel(run: SyncRun | null) {
  if (!run) return 'Awaiting sync'
  return run.status === 'succeeded' ? 'Synced' : `Sync ${run.status}`
}

/**
 * The fleet's heartbeat: how the most recent discovery run went and when. It
 * deliberately carries no live-region role — it refreshes on a timer and
 * would otherwise talk over whatever the operator is doing.
 */
export function SyncReadout({ run, unavailable }: { run: SyncRun | null; unavailable: boolean }) {
  return (
    <div className="sync-readout" title={run ? `${run.sourceName} · ${run.trigger}` : undefined}>
      <StatusDot domain="run" status={unavailable ? null : run?.status} className="sync-dot" />
      <div className="sync-readout-copy">
        <strong>{unavailable && !run ? 'Sync status unavailable' : statusLabel(run)}</strong>
        <span>{run ? relativeTime(run.queuedAt) : 'No activity yet'}</span>
      </div>
    </div>
  )
}
