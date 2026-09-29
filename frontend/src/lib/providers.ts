import type { Provider, SyncRun } from '../api/inventory'

/** Display order, and the managed-Kubernetes name each provider is known by. */
export const providers: Provider[] = ['aws', 'azure', 'gcp']

export const providerLabels: Record<Provider, string> = {
  aws: 'EKS',
  azure: 'AKS',
  gcp: 'GKE',
}

export const providerNames: Record<Provider, string> = {
  aws: 'Amazon Web Services',
  azure: 'Microsoft Azure',
  gcp: 'Google Cloud',
}

export function emptyProviderCounts(): Record<Provider, number> {
  return { aws: 0, azure: 0, gcp: 0 }
}

/**
 * Inventory older than two missed syncs (plus a minute of slack for the sync
 * itself) is no longer trusted.
 */
export function staleAfterMs(syncIntervalMs: number) {
  return 2 * syncIntervalMs + 60 * 1000
}

/** "5 min", "1 h", for describing the sync cadence. */
export function describeInterval(ms: number) {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  return `${hours} h`
}

const triggerLabels: Record<SyncRun['trigger'], string> = {
  auto: 'Automatic',
  scheduled: 'Scheduled',
  startup: 'Startup',
  cron: 'Nightly',
  manual: 'Manual',
}

/** What started a sync run, in words, e.g. "Automatic" for the UI's own refresh. */
export function syncTriggerLabel(trigger: SyncRun['trigger']) {
  return triggerLabels[trigger] ?? trigger
}
