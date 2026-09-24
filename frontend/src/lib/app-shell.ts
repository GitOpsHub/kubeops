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
