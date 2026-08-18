import { normalise, type Tone } from '../lib/status'

/**
 * Argo CD's own visual vocabulary: a heart for workload health and circular
 * arrows for sync, each toned by the state it reports. Operators who live in
 * the Argo UI read these two glyphs faster than any words, so the tile view
 * leads with them and keeps the words as captions.
 */

function healthTone(status: string): Tone {
  const health = normalise(status)
  if (health === 'healthy') return 'ok'
  if (health === 'progressing' || health === 'suspended') return 'warn'
  if (health === 'degraded' || health === 'missing') return 'err'
  return 'idle'
}

function syncTone(status: string): Tone {
  const sync = normalise(status)
  if (sync === 'synced') return 'ok'
  if (sync === 'outofsync') return 'warn'
  return 'idle'
}

type Props = {
  status: string
}

export function ArgoHealthState({ status }: Props) {
  const label = status || 'Unknown'
  const spinning = normalise(status) === 'progressing'
  return (
    <span
      className={`argo-state argo-state--${healthTone(status)}`}
      title={`Health: ${label}`}
      aria-label={`Health ${label}`}
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        fill="currentColor"
        className={spinning ? 'argo-state-icon--pulse' : undefined}
      >
        <path d="M12 20.4C7.6 16.9 3.5 13.4 3.5 9.3 3.5 6.6 5.6 4.5 8.2 4.5c1.5 0 3 .8 3.8 2.1.8-1.3 2.3-2.1 3.8-2.1 2.6 0 4.7 2.1 4.7 4.8 0 4.1-4.1 7.6-8.5 11.1z" />
      </svg>
      <span className="argo-state-label">{label}</span>
    </span>
  )
}

export function ArgoSyncState({ status }: Props) {
  const label = status || 'Unknown'
  const spinning = normalise(status) === 'progressing'
  return (
    <span
      className={`argo-state argo-state--${syncTone(status)}`}
      title={`Sync: ${label}`}
      aria-label={`Sync ${label}`}
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={spinning ? 'argo-state-icon--spin' : undefined}
      >
        <path d="M20 12a8 8 0 1 1-2.34-5.66" />
        <path d="M20 3v5h-5" />
      </svg>
      <span className="argo-state-label">{label}</span>
    </span>
  )
}
