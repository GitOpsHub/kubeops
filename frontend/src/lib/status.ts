import type { ApplicationDeployment } from '../api/onboarding'

/**
 * Status interpretation shared by the badges, the state delta, and the region
 * groups. Keeping it out of the components means "failed" resolves to the same
 * tone wherever it is drawn, and the mapping is testable on its own.
 */

export type Tone = 'ok' | 'warn' | 'err' | 'info' | 'idle'
export type DeltaTone = 'converged' | 'reconciling' | 'diverged' | 'unknown'

/**
 * Where a status value comes from. The same word can mean different things in
 * different places — "running" is a settled GKE cluster but a sync run still
 * in flight — so every lookup names its domain.
 *
 * - lifecycle: an onboarding or one of its deployment targets
 * - cluster: a discovered cluster or node pool
 * - run: a cloud-source sync run
 * - health: Argo CD workload health
 * - sync: Argo CD sync status
 * - operation: an Argo CD sync operation's phase
 */
export type StatusDomain = 'lifecycle' | 'cluster' | 'run' | 'health' | 'sync' | 'operation'

/** A glyph hint for components that draw an icon beside the tone. */
export type StatusIcon = 'ok' | 'warn' | 'err' | 'progress' | 'paused' | 'unknown' | 'removed'

export type StatusMeta = {
  tone: Tone
  /** The one display label for this value, e.g. "Out of Sync" for OutOfSync. */
  label: string
  icon?: StatusIcon
  /** Work still in flight: its indicator pulses. */
  inFlight: boolean
}

type Entry = [tone: Tone, label: string, icon?: StatusIcon, inFlight?: boolean]

const ok = (label: string): Entry => ['ok', label, 'ok']
const warn = (label: string): Entry => ['warn', label, 'warn']
const err = (label: string): Entry => ['err', label, 'err']
const idle = (label: string, icon: StatusIcon = 'unknown'): Entry => ['idle', label, icon]
const working = (label: string, tone: Tone = 'info'): Entry => [tone, label, 'progress', true]

// Keys are normalised (lower case, no spaces) so "OutOfSync", "Out of Sync",
// and "outofsync" all land on the same row.
const table: Record<StatusDomain, Record<string, Entry>> = {
  lifecycle: {
    healthy: ok('Healthy'),
    progressing: working('Progressing'),
    creating: working('Creating'),
    partial: warn('Partial'),
    failed: err('Failed'),
    offboarded: idle('Offboarded', 'removed'),
  },
  cluster: {
    active: ok('Active'),
    running: ok('Running'),
    ready: ok('Ready'),
    succeeded: ok('Succeeded'),
    creating: working('Creating'),
    provisioning: working('Provisioning'),
    updating: working('Updating'),
    reconciling: working('Reconciling'),
    pending: working('Pending'),
    scaling: working('Scaling'),
    stale: warn('Stale'),
    degraded: err('Degraded'),
    error: err('Error'),
    failed: err('Failed'),
    deleting: working('Deleting', 'warn'),
    stopping: working('Stopping', 'warn'),
    stopped: idle('Stopped', 'paused'),
    removed: idle('Removed', 'removed'),
    unknown: idle('Unknown'),
  },
  run: {
    queued: working('Queued'),
    running: working('Running'),
    succeeded: ok('Succeeded'),
    failed: err('Failed'),
    // A source's standing, derived from its latest run.
    stale: warn('Stale'),
    disabled: idle('Disabled', 'paused'),
    unknown: idle('Unknown'),
  },
  health: {
    healthy: ok('Healthy'),
    progressing: working('Progressing'),
    suspended: idle('Suspended', 'paused'),
    degraded: err('Degraded'),
    missing: err('Missing'),
    unknown: idle('Unknown'),
  },
  sync: {
    synced: ok('Synced'),
    outofsync: warn('Out of Sync'),
    progressing: working('Syncing'),
    unknown: idle('Unknown'),
  },
  operation: {
    running: working('Running'),
    terminating: working('Terminating', 'warn'),
    succeeded: ok('Succeeded'),
    failed: err('Failed'),
    error: err('Error'),
  },
}

const brokenValues = new Set(['outofsync', 'error', 'degraded', 'missing'])

export function normalise(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, '')
}

/**
 * Everything the UI needs to draw a status: its tone, its canonical label,
 * an icon hint, and whether it is still in flight. Values the table does not
 * know read as neutral and keep their own wording, so a new state from the
 * API still shows up rather than vanishing into "Unknown".
 */
export function statusMeta(domain: StatusDomain, value: string | null | undefined): StatusMeta {
  const key = normalise(value ?? '')
  const entry = table[domain][key]
  if (!entry) {
    return { tone: 'idle', label: value?.trim() || 'Unknown', icon: 'unknown', inFlight: false }
  }
  const [tone, label, icon, inFlight = false] = entry
  return { tone, label, icon, inFlight }
}

/** Argo CD workload health, as the heart glyph and graph cards colour it. */
export function healthTone(status: string): Tone {
  return statusMeta('health', status).tone
}

/** Argo CD sync state: matches Git, drifted, or not yet known. */
export function syncTone(status: string): Tone {
  return statusMeta('sync', status).tone
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

const deltaTones: Record<DeltaTone, Tone> = {
  converged: 'ok',
  reconciling: 'info',
  diverged: 'err',
  unknown: 'idle',
}

/** The tone a sync/health verdict is drawn in. */
export function deltaToneColour(delta: DeltaTone): Tone {
  return deltaTones[delta]
}

// Environments are not statuses, but borrowing the tone roles keeps their
// colours inside the palette and legible in both themes.
const environmentTones: Record<string, Tone> = { dev: 'info', qa: 'warn', prod: 'ok' }

export function environmentTone(environment: string): Tone {
  return environmentTones[environment] ?? 'idle'
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
