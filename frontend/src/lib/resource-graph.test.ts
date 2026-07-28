import { describe, expect, it } from 'vitest'
import type { ResourceNode } from '../api/onboarding'
import {
  cardHeight,
  cardWidth,
  columnGap,
  edgePath,
  layoutResourceGraph,
  sortResources,
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

// Deployment → ReplicaSet → two Pods, plus a standalone Service.
const fixture: ResourceNode[] = [
  node({ uid: 'pod-b', kind: 'Pod', name: 'api-b', parentUid: 'rs' }),
  node({ uid: 'pod-a', kind: 'Pod', name: 'api-a', parentUid: 'rs' }),
  node({ uid: 'rs', kind: 'ReplicaSet', name: 'api-1', parentUid: 'dep' }),
  node({ uid: 'dep', kind: 'Deployment', name: 'api' }),
  node({ uid: 'svc', kind: 'Service', name: 'api' }),
]

describe('layoutResourceGraph', () => {
  it('places each column by ownership depth', () => {
    const { nodes } = layoutResourceGraph(fixture)
    const byUid = new Map(nodes.map((item) => [item.uid, item]))

    expect(byUid.get('dep')?.x).toBe(0)
    expect(byUid.get('rs')?.x).toBe(cardWidth + columnGap)
    expect(byUid.get('pod-a')?.x).toBe((cardWidth + columnGap) * 2)
    expect(byUid.get('pod-b')?.x).toBe((cardWidth + columnGap) * 2)
    // A root with no children stays in the first column.
    expect(byUid.get('svc')?.x).toBe(0)
  })

  it('centres a parent on the children it owns', () => {
    const { nodes } = layoutResourceGraph(fixture)
    const byUid = new Map(nodes.map((item) => [item.uid, item]))

    const podYs = [byUid.get('pod-a')!.y, byUid.get('pod-b')!.y]
    const midpoint = (Math.min(...podYs) + Math.max(...podYs)) / 2
    expect(byUid.get('rs')?.y).toBe(midpoint)
    // The replica set is the deployment's only child, so they sit level.
    expect(byUid.get('dep')?.y).toBe(byUid.get('rs')?.y)
  })

  it('never overlaps two cards', () => {
    const { nodes } = layoutResourceGraph(fixture)

    for (const a of nodes) {
      for (const b of nodes) {
        if (a.uid === b.uid) continue
        const apart =
          Math.abs(a.x - b.x) >= cardWidth || Math.abs(a.y - b.y) >= cardHeight
        expect(apart, `${a.uid} overlaps ${b.uid}`).toBe(true)
      }
    }
  })

  it('sizes the canvas to bound every card', () => {
    const { nodes, width, height } = layoutResourceGraph(fixture)

    for (const item of nodes) {
      expect(item.x + cardWidth).toBeLessThanOrEqual(width)
      expect(item.y + cardHeight).toBeLessThanOrEqual(height)
    }
  })

  it('connects every parent to every child', () => {
    const { edges } = layoutResourceGraph(fixture)

    expect(edges.map((edge) => edge.id).sort()).toEqual([
      'dep->rs',
      'rs->pod-a',
      'rs->pod-b',
    ])
    // Edges leave the parent's right edge and arrive at the child's left edge.
    const toChild = edges.find((edge) => edge.id === 'rs->pod-a')!
    expect(toChild.fromX).toBe(cardWidth + columnGap + cardWidth)
    expect(toChild.toX).toBe((cardWidth + columnGap) * 2)
  })

  it('keeps a node whose parent is missing from the response', () => {
    const orphan = [node({ uid: 'lonely', kind: 'Pod', name: 'lonely', parentUid: 'gone' })]
    const { nodes } = layoutResourceGraph(orphan)

    expect(nodes).toHaveLength(1)
    expect(nodes[0].x).toBe(0)
  })

  it('handles an empty response', () => {
    expect(layoutResourceGraph([])).toEqual({ nodes: [], edges: [], width: 0, height: 0 })
  })
})

describe('edgePath', () => {
  it('draws a straight line between cards on the same row', () => {
    const path = edgePath({ id: 'a', fromX: 0, fromY: 50, toX: 100, toY: 50 })
    expect(path).toBe('M 0 50 H 100')
  })

  it('turns through a midpoint when the rows differ', () => {
    const path = edgePath({ id: 'a', fromX: 0, fromY: 0, toX: 100, toY: 80 })
    expect(path).toContain('M 0 0')
    expect(path).toContain('H 100')
    expect(path).toContain('A ')
  })
})

describe('sortResources', () => {
  it('sorts by age using the timestamp, not the formatted label', () => {
    const nodes = [
      node({ uid: 'old', name: 'old', createdAt: '2026-01-01T00:00:00Z' }),
      node({ uid: 'new', name: 'new', createdAt: '2026-07-01T00:00:00Z' }),
    ]

    expect(sortResources(nodes, 'createdAt', 'asc').map((item) => item.uid)).toEqual([
      'old',
      'new',
    ])
    expect(sortResources(nodes, 'createdAt', 'desc').map((item) => item.uid)).toEqual([
      'new',
      'old',
    ])
  })

  it('breaks ties on name so equal kinds stay in a readable order', () => {
    const nodes = [
      node({ uid: '1', kind: 'Pod', name: 'zebra' }),
      node({ uid: '2', kind: 'Pod', name: 'alpha' }),
    ]

    expect(sortResources(nodes, 'kind', 'asc').map((item) => item.name)).toEqual([
      'alpha',
      'zebra',
    ])
    // Reversing the column must not reshuffle rows that tie on it.
    expect(sortResources(nodes, 'kind', 'desc').map((item) => item.name)).toEqual([
      'alpha',
      'zebra',
    ])
  })

  it('leaves the input untouched', () => {
    const nodes = [node({ uid: 'b', name: 'b' }), node({ uid: 'a', name: 'a' })]
    sortResources(nodes, 'name', 'asc')
    expect(nodes.map((item) => item.uid)).toEqual(['b', 'a'])
  })
})
