import type { SyncRun } from '../../api/inventory'
import type { Overview, SyncRunDay } from '../../api/overview'
import { chartSlot, type ChartColor } from '../../components/charts/chart-utils'
import { providers } from '../../lib/providers'
import { normalise, statusMeta, type StatusDomain } from '../../lib/status'

/**
 * The arithmetic behind the Overview tiles and charts, kept out of the page so
 * it can be tested without rendering and so a missing count never turns into
 * NaN on screen.
 */

export type CountSegment = {
  id: string
  label: string
  value: number
  tone: ChartColor
}

/**
 * Status counts as chart segments in a fixed order, so a state keeps its
 * place (and colour) as the counts move. Values the order does not know are
 * appended rather than dropped.
 */
export function statusSegments(
  domain: StatusDomain,
  counts: Record<string, number> | undefined,
  order: string[],
  { includeEmpty = true } = {},
): CountSegment[] {
  const entries = Object.entries(counts ?? {})
  const known = new Set(order.map(normalise))
  const keys = [
    ...order.map((key) => entries.find(([name]) => normalise(name) === normalise(key))?.[0] ?? key),
    ...entries.map(([name]) => name).filter((name) => !known.has(normalise(name))),
  ]
  return keys
    .map((key) => {
      const meta = statusMeta(domain, key)
      return { id: key, label: meta.label, value: count(counts?.[key]), tone: meta.tone }
    })
    .filter((segment) => includeEmpty || segment.value > 0)
}

export const applicationStatusOrder = ['failed', 'partial', 'progressing', 'healthy']
export const targetHealthOrder = [
  'Healthy',
  'Progressing',
  'Suspended',
  'Degraded',
  'Missing',
  'Unknown',
]
export const targetSyncOrder = ['Synced', 'OutOfSync', 'Unknown']

/**
 * Providers in their display order, each on its own categorical slot. The slot
 * follows the provider, not its rank, so a provider keeps its colour whichever
 * others are present.
 */
export function providerCounts(byProvider: Record<string, number> | undefined) {
  const known = providers
    .map((provider, index) => ({
      provider,
      value: count(byProvider?.[provider]),
      color: chartSlot(index),
    }))
    .filter((entry) => entry.value > 0)
  const other = Object.entries(byProvider ?? {})
    .filter(([provider]) => !(providers as string[]).includes(provider))
    .reduce((sum, [, value]) => sum + count(value), 0)
  return { known, other, otherColor: chartSlot(providers.length) }
}

/** "83%" of targets healthy, or null when there are no targets to judge. */
export function healthyTargetShare(targets: Overview['applications']['targets'] | undefined) {
  const total = count(targets?.total)
  const healthy = Object.entries(targets?.byHealth ?? {})
    .filter(([status]) => normalise(status) === 'healthy')
    .reduce((sum, [, value]) => sum + count(value), 0)
  return { healthy, total, percent: total > 0 ? (healthy / total) * 100 : null }
}

export function syncSuccessRate(last24h: Overview['syncRuns']['last24h'] | undefined) {
  const succeeded = count(last24h?.succeeded)
  const failed = count(last24h?.failed)
  const completed = succeeded + failed
  return {
    succeeded,
    failed,
    completed,
    running: count(last24h?.running),
    percent: completed > 0 ? (succeeded / completed) * 100 : null,
  }
}

/** Each day's success rate, with a gap on days nothing completed. */
export function dailySuccessRates(days: SyncRunDay[] | undefined) {
  return (days ?? []).map((day) => {
    const completed = count(day.succeeded) + count(day.failed)
    return completed > 0 ? (count(day.succeeded) / completed) * 100 : null
  })
}

/** Change in fleet size across the series, e.g. +2 over 14 days. */
export function seriesDelta(values: number[]) {
  if (values.length < 2) return 0
  return values[values.length - 1] - values[0]
}

export function runDurationMs(run: Pick<SyncRun, 'startedAt' | 'completedAt'>) {
  if (!run.startedAt || !run.completedAt) return null
  const ms = new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()
  return Number.isFinite(ms) && ms >= 0 ? ms : null
}

/** "850ms", "12s", "1m 5s", "2h 4m". */
export function formatDuration(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 10) return `${Number(seconds.toFixed(1))}s`
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    const rest = Math.round(seconds - minutes * 60)
    return rest ? `${minutes}m ${rest}s` : `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  const rest = minutes - hours * 60
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}

export function formatShare(percent: number | null) {
  if (percent === null) return '—'
  // Never round a failure away: 99.6% is not 100%.
  if (percent < 100 && percent > 99) return '99%'
  return `${Math.round(percent)}%`
}

/** Nothing discovered, onboarded, synced, or failing: the first-run state. */
export function isEmptyFleet(overview: Overview) {
  return (
    count(overview.clusters.total) === 0 &&
    count(overview.applications.total) === 0 &&
    overview.syncRuns.recent.length === 0 &&
    overview.attention.length === 0
  )
}

function count(value: number | undefined | null) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}
