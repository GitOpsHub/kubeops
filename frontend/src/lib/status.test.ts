import { describe, expect, it } from 'vitest'
import { deltaTone, statusMeta, type StatusDomain, type StatusMeta } from './status'

describe('statusMeta', () => {
  const cases: [StatusDomain, string | null, Partial<StatusMeta>][] = [
    // Argo CD sync reads the same however the API spells it.
    ['sync', 'OutOfSync', { tone: 'warn', label: 'Out of Sync', inFlight: false }],
    ['sync', 'Out of Sync', { tone: 'warn', label: 'Out of Sync' }],
    ['sync', 'Synced', { tone: 'ok', label: 'Synced' }],
    ['sync', '', { tone: 'idle', label: 'Unknown' }],
    ['health', 'Healthy', { tone: 'ok', label: 'Healthy', icon: 'ok' }],
    ['health', 'Progressing', { tone: 'info', inFlight: true, icon: 'progress' }],
    ['health', 'Suspended', { tone: 'idle', icon: 'paused' }],
    ['health', 'Degraded', { tone: 'err' }],
    ['health', 'Missing', { tone: 'err' }],
    ['lifecycle', 'healthy', { tone: 'ok', label: 'Healthy' }],
    ['lifecycle', 'creating', { tone: 'info', inFlight: true }],
    ['lifecycle', 'partial', { tone: 'warn', label: 'Partial' }],
    ['lifecycle', 'failed', { tone: 'err' }],
    ['lifecycle', 'offboarded', { tone: 'idle', icon: 'removed' }],
    // "running" is settled for a cluster and in flight for a sync run.
    ['cluster', 'RUNNING', { tone: 'ok', label: 'Running', inFlight: false }],
    ['run', 'running', { tone: 'info', label: 'Running', inFlight: true }],
    ['cluster', 'active', { tone: 'ok', label: 'Active' }],
    ['cluster', 'stale', { tone: 'warn' }],
    ['cluster', 'deleting', { tone: 'warn', inFlight: true }],
    ['cluster', 'removed', { tone: 'idle', icon: 'removed' }],
    ['run', 'queued', { tone: 'info', inFlight: true }],
    ['run', 'succeeded', { tone: 'ok' }],
    ['operation', 'Terminating', { tone: 'warn', inFlight: true }],
    ['operation', 'Error', { tone: 'err' }],
    // Unknown values stay visible in their own words, neutrally.
    ['cluster', 'Hibernating', { tone: 'idle', label: 'Hibernating', inFlight: false }],
    ['run', null, { tone: 'idle', label: 'Unknown' }],
  ]

  it.each(cases)('%s %j', (domain, value, expected) => {
    expect(statusMeta(domain, value)).toMatchObject(expected)
  })
})

describe('deltaTone', () => {
  it.each([
    ['Synced', 'Healthy', 'converged'],
    ['Synced', 'Progressing', 'reconciling'],
    ['OutOfSync', 'Healthy', 'diverged'],
    ['Synced', 'Degraded', 'diverged'],
    ['', '', 'unknown'],
    ['Synced', 'Suspended', 'unknown'],
  ])('reads sync %s and health %s as %s', (sync, health, expected) => {
    expect(deltaTone(sync, health)).toBe(expected)
  })
})
