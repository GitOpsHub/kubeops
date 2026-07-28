/**
 * Argo CD reports two states for every application: whether the cluster matches
 * the declared manifests (sync) and whether the running workloads are well
 * (health). They are the two ends of one reconciliation loop, so this renders
 * them joined by a rail whose treatment carries the verdict — solid when the
 * loop has closed, marching when it is still converging, broken when it came
 * apart.
 */

import { deltaTone, normalise } from '../lib/status'

type Props = {
  syncStatus: string
  healthStatus: string
  /** Hides the text labels where space is tight; the aria-label still reads both. */
  compact?: boolean
}

function settled(value: string, expected: string) {
  return normalise(value) === expected
}

export function StateDelta({ syncStatus, healthStatus, compact = false }: Props) {
  const sync = syncStatus || 'Unknown'
  const health = healthStatus || 'Unknown'
  const tone = deltaTone(syncStatus, healthStatus)

  return (
    <span
      className={`state-delta state-delta--${tone}`}
      role="img"
      aria-label={`Sync ${sync}, health ${health}`}
    >
      {!compact && <span className="state-delta-label">{sync}</span>}
      <span className="state-delta-rail" aria-hidden="true">
        <i
          className={`state-delta-node ${settled(sync, 'synced') ? '' : 'state-delta-node--pending'}`}
        />
        <i className="state-delta-track" />
        <i
          className={`state-delta-node ${
            settled(health, 'healthy') ? '' : 'state-delta-node--pending'
          }`}
        />
      </span>
      {!compact && <span className="state-delta-label">{health}</span>}
    </span>
  )
}

/** Explains the three rail treatments once, above a table of them. */
export function StateDeltaLegend() {
  return (
    <div className="delta-legend">
      <span>
        <StateDelta syncStatus="Synced" healthStatus="Healthy" compact /> converged
      </span>
      <span>
        <StateDelta syncStatus="Progressing" healthStatus="Progressing" compact /> reconciling
      </span>
      <span>
        <StateDelta syncStatus="OutOfSync" healthStatus="Degraded" compact /> diverged
      </span>
    </div>
  )
}
