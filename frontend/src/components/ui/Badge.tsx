import type { ReactNode } from 'react'
import { isInFlight, statusTone, type Tone } from '../../lib/status'
import './Badge.css'

type StatusProps = {
  status: string
  /** Overrides the derived tone when the caller knows better (e.g. a removed row). */
  tone?: Tone
}

/**
 * One badge for every status the API reports — cluster health, deployment
 * state, sync runs — so "failed" is the same red wherever it appears. Work
 * still in flight breathes.
 */
export function StatusBadge({ status, tone }: StatusProps) {
  const resolved = tone ?? statusTone(status)
  const pulse = isInFlight(status)
  return (
    <span
      className={`status-badge status-badge--${resolved}${pulse ? ' status-badge--pulse' : ''}`}
    >
      {status}
    </span>
  )
}

/** A neutral tag for identifiers: environments, regions, source IDs. */
export function Tag({
  children,
  mono = false,
  title,
}: {
  children: ReactNode
  mono?: boolean
  title?: string
}) {
  return (
    <span className={mono ? 'tag tag--mono' : 'tag'} title={title}>
      {children}
    </span>
  )
}
