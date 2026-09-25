import { request } from './client'
import type { SyncRun } from './inventory'
import type { OnboardingStatus } from './onboarding'

export type DailyCount = {
  /** A UTC day, "YYYY-MM-DD". */
  date: string
  total: number
}

export type SyncRunDay = {
  date: string
  succeeded: number
  failed: number
  /** Over that day's succeeded runs; null on a day without one. */
  p50Ms: number | null
  p95Ms: number | null
}

export type AttentionItem = {
  kind: 'application' | 'cluster' | 'source'
  id: string
  name: string
  status: string
  message?: string
  /** An in-app path, already filtered to the item. */
  href: string
}

/**
 * The fleet summary behind the Overview, computed server-side so the page
 * makes one request instead of paging every list. Clusters, sources, and sync
 * runs are scoped to the configured sources; applications are not, matching
 * the applications list. Series run oldest first and end today (UTC).
 */
export type Overview = {
  generatedAt: string
  clusters: {
    total: number
    byProvider: Record<string, number>
    byStatus: Record<string, number>
    series14d: DailyCount[]
  }
  applications: {
    /** Releases (one per environment and region), excluding offboarded ones. */
    total: number
    byStatus: Partial<Record<OnboardingStatus, number>>
    targets: {
      total: number
      byHealth: Record<string, number>
      bySync: Record<string, number>
    }
  }
  syncRuns: {
    last24h: { succeeded: number; failed: number; running: number }
    series14d: SyncRunDay[]
    recent: SyncRun[]
  }
  /** Worst first, at most 20. */
  attention: AttentionItem[]
}

export function getOverview(signal?: AbortSignal) {
  return request<Overview>('/overview', { signal })
}
