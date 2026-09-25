import type { SyncRun } from '../api/inventory'
import { StatusDot } from '../components/ui/StatusDot'
import { useNow } from '../hooks/useNow'
import { syncRunLabel } from '../lib/app-shell'
import { relativeTime } from '../lib/format'

/**
 * The fleet's heartbeat: how the most recent discovery run went and when. It
 * deliberately carries no live-region role — it refreshes on a timer and
 * would otherwise talk over whatever the operator is doing.
 */
export function SyncReadout({ run, unavailable }: { run: SyncRun | null; unavailable: boolean }) {
  const now = useNow()
  return (
    <div className="sync-readout" title={run ? `${run.sourceName} · ${run.trigger}` : undefined}>
      <StatusDot domain="run" status={unavailable ? null : run?.status} className="sync-dot" />
      <div className="sync-readout-copy">
        <strong>{unavailable && !run ? 'Sync status unavailable' : syncRunLabel(run)}</strong>
        <span className="num">
          {run ? `${run.sourceName} · ${relativeTime(run.queuedAt, now)}` : 'No activity yet'}
        </span>
      </div>
    </div>
  )
}
