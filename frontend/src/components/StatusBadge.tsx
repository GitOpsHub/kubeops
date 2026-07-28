import { isInFlight, statusTone, type Tone } from '../lib/status'

/**
 * One badge for every status the API reports — cluster health, deployment
 * state, sync runs — so "failed" is the same red wherever it appears.
 */

type Props = {
  status: string
  /** Overrides the derived tone when the caller knows better (e.g. a removed row). */
  tone?: Tone
}

export function StatusBadge({ status, tone }: Props) {
  const resolved = tone ?? statusTone(status)
  const pulse = isInFlight(status)

  return (
    <span className={`status-badge status-badge--${resolved} ${pulse ? 'status-badge--pulse' : ''}`}>
      {status}
    </span>
  )
}
