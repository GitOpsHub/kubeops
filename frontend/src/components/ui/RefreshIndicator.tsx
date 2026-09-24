import { useNow } from '../../hooks/useNow'
import { relativeTime } from '../../lib/format'
import { StatusDot } from './StatusDot'
import './RefreshIndicator.css'

type Props = {
  lastUpdated: number | null
  refreshing: boolean
  /** The last request failed; whatever is on screen may be stale. */
  failed?: boolean
  /** Shown before the first successful load. */
  idleLabel?: string
}

/**
 * The quiet "this data is live" readout: when it last arrived, and a small
 * spinner while a background refresh is running. It replaces the loaders that
 * used to swap the whole page out on every poll.
 */
export function RefreshIndicator({
  lastUpdated,
  refreshing,
  failed = false,
  idleLabel = 'Loading…',
}: Props) {
  const now = Math.max(useNow(), lastUpdated ?? 0)

  return (
    <span className="refresh-indicator">
      {refreshing ? (
        <span className="spinner refresh-indicator-spinner" aria-hidden="true" />
      ) : (
        <StatusDot tone={failed ? 'err' : 'ok'} size="sm" />
      )}
      {failed && !refreshing && !lastUpdated
        ? 'Not loaded'
        : lastUpdated
          ? `Updated ${relativeTime(new Date(Math.min(lastUpdated, now)).toISOString(), now)}`
          : idleLabel}
    </span>
  )
}
