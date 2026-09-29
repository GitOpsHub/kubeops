import { describe, expect, it } from 'vitest'
import { clusterStatus, isInFlight, statusTone } from './status'

describe('clusterStatus', () => {
  it.each([
    ['ACTIVE', null, 'active'],
    ['RUNNING', null, 'active'],
    ['succeeded', null, 'active'],
    ['UPDATING', null, 'updating'],
    ['RECONCILING', null, 'reconciling'],
    ['FAILED', null, 'failed'],
    ['STATUS_UNSPECIFIED', null, 'unknown'],
    ['', null, 'unknown'],
    ['ACTIVE', '2026-09-01T00:00:00Z', 'removed'],
  ])('reads %s (removed %s) as %s', (status, removedAt, expected) => {
    expect(clusterStatus({ status, removedAt })).toBe(expected)
  })

  it('never shows a healthy cluster as in flight', () => {
    expect(isInFlight(clusterStatus({ status: 'RUNNING', removedAt: null }))).toBe(false)
    expect(statusTone(clusterStatus({ status: 'RUNNING', removedAt: null }))).toBe('ok')
  })

  it('colours provider failure states as errors', () => {
    for (const status of ['failed', 'error', 'degraded', 'canceled']) {
      expect(statusTone(status)).toBe('err')
    }
  })
})
