import type { ApplicationDeployment } from '../api/onboarding'

/**
 * Status interpretation shared by the badges, the state delta, and the region
 * groups. Keeping it out of the components means "failed" resolves to the same
 * tone wherever it is drawn, and the mapping is testable on its own.
 */

export type Tone = 'ok' | 'warn' | 'err' | 'accent' | 'idle'
export type DeltaTone = 'converged' | 'reconciling' | 'diverged' | 'unknown'

const tones: Record<string, Tone> = {
  // Onboarding and deployment lifecycle.
  healthy: 'ok',
  progressing: 'warn',
  creating: 'warn',
  partial: 'warn',
  failed: 'err',
  offboarded: 'idle',
  // Cluster inventory and sync runs.
  active: 'ok',
  running: 'ok',
  succeeded: 'ok',
  updating: 'warn',
  pending: 'warn',
  queued: 'warn',
  stale: 'warn',
  degraded: 'err',
  deleting: 'err',
  removed: 'idle',
  unknown: 'idle',
}

/** Statuses describing work still in flight, so their indicator breathes. */
const inFlight = new Set(['progressing', 'creating', 'updating', 'pending', 'running', 'queued'])

const brokenValues = new Set(['outofsync', 'error', 'degraded', 'missing'])

export function normalise(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, '')
}

export function statusTone(status: string): Tone {
  return tones[normalise(status)] ?? 'idle'
}

export function isInFlight(status: string) {
  return inFlight.has(normalise(status))
}

/**
 * Reads Argo CD's two axes as one verdict: converged when the loop has closed,
 * reconciling while it is still converging, diverged when the ends came apart.
 */
export function deltaTone(syncStatus: string, healthStatus: string): DeltaTone {
  const sync = normalise(syncStatus)
  const health = normalise(healthStatus)

  if (!sync && !health) return 'unknown'
  if (sync === 'progressing' || health === 'progressing') return 'reconciling'
  if (brokenValues.has(sync) || brokenValues.has(health)) return 'diverged'
  if (sync === 'synced' && health === 'healthy') return 'converged'
  return 'unknown'
}

/** Groups deployment targets by region, sorted, with unset regions labelled. */
export function groupByRegion(targets: ApplicationDeployment[]) {
  const groups = new Map<string, ApplicationDeployment[]>()
  for (const target of targets) {
    const region = target.region || 'no region'
    const existing = groups.get(region)
    if (existing) existing.push(target)
    else groups.set(region, [target])
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([region, items]) => ({ region, targets: items }))
}

/** The one sync/health pair worth showing when a row is collapsed. */
export function rollupState(targets: ApplicationDeployment[]) {
  if (targets.length === 0) return { syncStatus: '', healthStatus: '' }
  const worst =
    targets.find((target) => target.status === 'failed') ??
    targets.find((target) => target.status === 'progressing' || target.status === 'creating') ??
    targets[0]
  return { syncStatus: worst.syncStatus, healthStatus: worst.healthStatus }
}
