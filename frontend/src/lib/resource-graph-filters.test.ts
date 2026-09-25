import { describe, expect, it } from 'vitest'
import type { ResourceNode } from '../api/onboarding'
import {
  emptyResourceFilters,
  filterResources,
  hasActiveFilters,
  middleTruncate,
  resourceHealthLabel,
  resourceStatusMessage,
  resourceSyncLabel,
} from './resource-graph'

function node(overrides: Partial<ResourceNode> & { uid: string }): ResourceNode {
  return {
    group: 'apps',
    version: 'v1',
    kind: 'Deployment',
    namespace: 'payments',
    name: overrides.uid,
    parentUid: '',
    healthStatus: 'Healthy',
    syncStatus: 'Synced',
    createdAt: '2026-07-01T00:00:00Z',
    ...overrides,
  }
}

const nodes = [
  node({ uid: 'dep' }),
  node({ uid: 'rs', kind: 'ReplicaSet', parentUid: 'dep', syncStatus: '' }),
  node({ uid: 'pod', kind: 'Pod', parentUid: 'rs', syncStatus: '', healthStatus: 'Degraded' }),
  node({ uid: 'svc', kind: 'Service', syncStatus: 'OutOfSync', healthStatus: '' }),
]

describe('graph filters', () => {
  it.each([
    [{}, ['dep', 'rs', 'pod', 'svc'], false],
    [{ kinds: ['Pod', 'Service'] }, ['pod', 'svc'], true],
    [{ health: 'Degraded' }, ['pod'], true],
    [{ health: 'Unknown' }, ['svc'], true],
    [{ sync: 'Out of Sync' }, ['svc'], true],
    [{ hideReplicaSetsAndPods: true }, ['dep', 'svc'], true],
    // The search dims in the view; it never removes.
    [{ search: 'zzz' }, ['dep', 'rs', 'pod', 'svc'], false],
  ])('%o shows %o', (patch, uids, active) => {
    const filters = { ...emptyResourceFilters, ...patch }
    expect(filterResources(nodes, filters).map((item) => item.uid)).toEqual(uids)
    expect(hasActiveFilters(filters)).toBe(active)
  })

  it('uses canonical labels', () => {
    expect(resourceHealthLabel(nodes[3])).toBe('Unknown')
    expect(resourceSyncLabel(nodes[3])).toBe('Out of Sync')
    expect(resourceSyncLabel(nodes[2])).toBe('')
  })
})

describe('card copy', () => {
  it.each([
    ['Healthy', undefined, ''],
    ['Suspended', undefined, ''],
    ['Progressing', undefined, 'Progressing'],
    [
      'Degraded',
      [{ name: 'Status Reason', value: 'CrashLoopBackOff' }],
      'Degraded · CrashLoopBackOff',
    ],
    ['Missing', [{ name: 'Containers', value: '0/1' }], 'Missing'],
  ])('%s with %o reads %o', (healthStatus, info, message) => {
    expect(resourceStatusMessage(node({ uid: 'x', healthStatus, info }))).toBe(message)
  })

  it.each([
    ['payments-api', 22, 'payments-api'],
    ['payments-api-7d9f8c6b5-x7k2p', 22, 'payments…9f8c6b5-x7k2p'],
    ['abcdefghij', 5, 'a…hij'],
  ])('middle-truncates %s to %i', (name, max, expected) => {
    expect(middleTruncate(name, max)).toBe(expected)
    expect(middleTruncate(name, max).length).toBeLessThanOrEqual(max)
  })
})
