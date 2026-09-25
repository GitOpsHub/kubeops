import { describe, expect, it } from 'vitest'
import {
  dailySuccessRates,
  formatDuration,
  formatShare,
  healthyTargetShare,
  providerCounts,
  runDurationMs,
  statusSegments,
  syncSuccessRate,
} from './overview-metrics'

describe('overview metrics', () => {
  it.each([
    { ms: 850, text: '850ms' },
    { ms: 4_250, text: '4.3s' },
    { ms: 42_000, text: '42s' },
    { ms: 65_000, text: '1m 5s' },
    { ms: 120_000, text: '2m' },
    { ms: 7_440_000, text: '2h 4m' },
    { ms: Number.NaN, text: '—' },
  ])('formats $ms ms as $text', ({ ms, text }) => {
    expect(formatDuration(ms)).toBe(text)
  })

  it.each([
    { percent: null, text: '—' },
    { percent: 100, text: '100%' },
    { percent: 99.6, text: '99%' },
    { percent: 83.33, text: '83%' },
  ])('formats a $percent share as $text', ({ percent, text }) => {
    expect(formatShare(percent)).toBe(text)
  })

  it('keeps status segments in a fixed order and appends unknown states', () => {
    const segments = statusSegments('health', { Missing: 1, Healthy: 4, Weird: 2 }, [
      'Healthy',
      'Degraded',
      'Missing',
    ])
    expect(segments.map((segment) => [segment.id, segment.label, segment.value])).toEqual([
      ['Healthy', 'Healthy', 4],
      ['Degraded', 'Degraded', 0],
      ['Missing', 'Missing', 1],
      ['Weird', 'Weird', 2],
    ])
    expect(segments[0].tone).toBe('ok')
    expect(
      statusSegments('health', { Healthy: 4 }, ['Healthy', 'Degraded'], { includeEmpty: false }),
    ).toHaveLength(1)
  })

  it('gives each provider a fixed slot and folds unknown ones into Other', () => {
    const counts = providerCounts({ gcp: 2, aws: 1, openshift: 4 })
    expect(counts.known.map((entry) => [entry.provider, entry.color])).toEqual([
      ['aws', 'chart-1'],
      ['gcp', 'chart-3'],
    ])
    expect(counts.other).toBe(4)
  })

  it('reports shares as null rather than NaN when there is nothing to divide', () => {
    expect(healthyTargetShare({ total: 0, byHealth: {}, bySync: {} }).percent).toBeNull()
    expect(healthyTargetShare({ total: 4, byHealth: { Healthy: 3 }, bySync: {} }).percent).toBe(75)
    expect(syncSuccessRate({ succeeded: 0, failed: 0, running: 2 })).toMatchObject({
      percent: null,
      running: 2,
    })
    expect(
      dailySuccessRates([
        { date: '2026-09-23', succeeded: 3, failed: 1, p50Ms: 10, p95Ms: 20 },
        { date: '2026-09-24', succeeded: 0, failed: 0, p50Ms: null, p95Ms: null },
      ]),
    ).toEqual([75, null])
  })

  it('times a run only once it has both ends', () => {
    expect(runDurationMs({ startedAt: '2026-09-24T10:00:00Z', completedAt: null })).toBeNull()
    expect(
      runDurationMs({ startedAt: '2026-09-24T10:00:00Z', completedAt: '2026-09-24T10:00:42Z' }),
    ).toBe(42_000)
  })
})
