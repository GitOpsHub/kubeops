/**
 * What a routed page may tell the shell around it. Kept deliberately small:
 * the shell owns layout and the sync readout, pages own their data.
 */

export type ApplicationTopbarState = {
  /** Shown as the last breadcrumb in place of the application's ID. */
  name: string
}

export type AppShellContext = {
  setApplicationTopbar: (state: ApplicationTopbarState | null) => void
  /** Refreshes the sidebar's sync readout, e.g. right after queueing a sync. */
  refreshSyncStatus: () => Promise<void>
}

type RunLike = { status: string }

/**
 * The heartbeat's headline for a sync run. "Synced" and "Sync queued" are
 * what operators (and the tests) look for, so both the sidebar and the header
 * menu word it through here.
 */
export function syncRunLabel(run: RunLike | null) {
  if (!run) return 'Awaiting sync'
  return run.status === 'succeeded' ? 'Synced' : `Sync ${run.status}`
}

/** Queued and running runs have no meaningful "ago" yet; they are still happening. */
export function isRunInFlight(run: RunLike | null) {
  return run?.status === 'queued' || run?.status === 'running'
}
