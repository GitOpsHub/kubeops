import type { SyncRun } from '../api/inventory'

export type ApplicationEndpoint = {
  label: string
  url: string
}

export type ApplicationTopbarState = {
  name: string
  syncStatus: 'Synced' | 'Out of Sync' | 'Sync pending'
  endpoints: ApplicationEndpoint[]
}

export type AppShellContext = {
  onLatestRunChange: (run: SyncRun | null) => void
  setApplicationTopbar: (state: ApplicationTopbarState | null) => void
}
