import type { CloudSource, SyncRun } from '../../api/inventory'
import { isOlderThan } from '../../lib/format'
import { staleAfterMs } from '../../lib/providers'

/**
 * How long a run took, from the moment a worker picked it up to its
 * completion; queue time is not the provider's fault. A run still going
 * measures against `now`. Null when it has not started or the timestamps are
 * unusable.
 */
export function runDurationMs(run: SyncRun, now = Date.now()) {
  if (!run.startedAt) return null
  const started = new Date(run.startedAt).getTime()
  const ended = run.completedAt ? new Date(run.completedAt).getTime() : now
  if (Number.isNaN(started) || Number.isNaN(ended)) return null
  return Math.max(0, ended - started)
}

/** "840ms", "4.2s", "3m 12s", "1h 04m". */
export function formatDuration(ms: number | null) {
  if (ms === null) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 10) return `${seconds.toFixed(1)}s`
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** A succeeded sync that is too old to trust reads as stale, not healthy. */
export function sourceStanding(source: CloudSource, now = Date.now()) {
  if (!source.enabled) return 'disabled'
  if (source.lastSyncStatus === 'succeeded' && isOlderThan(source.lastSyncAt, staleAfterMs, now)) {
    return 'stale'
  }
  return source.lastSyncStatus || 'unknown'
}

/** Newest-first runs split per source, each list capped at `limit`. */
export function runsBySource(runs: SyncRun[], limit: number) {
  const grouped = new Map<string, SyncRun[]>()
  for (const run of runs) {
    const list = grouped.get(run.sourceId)
    if (!list) grouped.set(run.sourceId, [run])
    else if (list.length < limit) list.push(run)
  }
  return grouped
}
