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

// The same resources Kubernetes presents: network and identity alongside the
// Deployment → ReplicaSet → Pod ownership chain.
const fixture: ResourceNode[] = [
  node({ uid: 'pod-b', kind: 'Pod', name: 'api-b', parentUid: 'rs' }),
  node({ uid: 'pod-a', kind: 'Pod', name: 'api-a', parentUid: 'rs' }),
  node({ uid: 'rs', kind: 'ReplicaSet', name: 'api-1', parentUid: 'dep' }),
  node({ uid: 'dep', kind: 'Deployment', name: 'api-deployment' }),
  node({ uid: 'svc', kind: 'Service', name: 'api-service' }),
  node({ uid: 'sa', kind: 'ServiceAccount', name: 'api-service-account' }),
]

describe('layoutResourceGraph', () => {
  it('places resources in Kubernetes semantic lanes', () => {
    const { nodes } = layoutResourceGraph(fixture)
    const byUid = new Map(nodes.map((item) => [item.uid, item]))

    // Traffic and identity precede workloads; controller ownership still reads
    // naturally from left to right.
    expect(byUid.get('svc')?.x).toBe(0)
    expect(byUid.get('sa')?.x).toBe(0)
    expect(byUid.get('dep')?.x).toBe(cardWidth + columnGap)
    expect(byUid.get('rs')?.x).toBe((cardWidth + columnGap) * 2)
    expect(byUid.get('pod-a')?.x).toBe((cardWidth + columnGap) * 3)
    expect(byUid.get('pod-b')?.x).toBe((cardWidth + columnGap) * 3)
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

  it('connects ownership and the Service to its workload', () => {
    const { edges, nodes } = layoutResourceGraph(fixture)

    expect(edges.map((edge) => edge.id).sort()).toEqual([
      'owns:dep->rs',
      'owns:rs->pod-a',
      'owns:rs->pod-b',
      'routes:svc->dep',
    ])
    expect(edges.filter((edge) => edge.relation === 'owns')).toHaveLength(3)
    expect(edges.filter((edge) => edge.relation === 'routes')).toHaveLength(1)

    const toChild = edges.find((edge) => edge.id === 'owns:rs->pod-a')!
    expect(toChild.fromX).toBe((cardWidth + columnGap) * 2 + cardWidth)
    expect(toChild.toX).toBe((cardWidth + columnGap) * 3)

    const byUid = new Map(nodes.map((item) => [item.uid, item]))
    expect(byUid.get('svc')?.y).toBe(byUid.get('dep')?.y)
  })

  it('places a cloud load balancer before an exposed Service', () => {
    const exposed = fixture.map((item) =>
      item.uid === 'svc'
        ? {
            ...item,
            exposure: {
              type: 'LoadBalancer',
              addresses: ['35.237.212.233'],
              ports: ['80/TCP'],
            },
          }
        : item,
    )
    const { nodes, edges, lanes } = layoutResourceGraph(exposed)
    const loadBalancer = nodes.find((item) => item.kind === 'LoadBalancer')
    const service = nodes.find((item) => item.uid === 'svc')

    expect(loadBalancer).toMatchObject({
      name: '35.237.212.233',
      virtual: true,
      sourceUid: 'svc',
      x: 0,
    })
    expect(service?.x).toBe(cardWidth + columnGap)
    expect(loadBalancer?.y).toBe(service?.y)
    expect(service?.y).toBe(nodes.find((item) => item.uid === 'dep')?.y)
    expect(lanes.map((lane) => lane.label)).toEqual([
      'Entry',
      'Network & identity',
      'Workloads',
      'Controllers',
      'Pods',
    ])
    expect(edges.map((edge) => edge.id)).toContain(
      'routes:external-load-balancer:svc->svc',
    )
    expect(edges.map((edge) => edge.id)).toContain('routes:svc->dep')
  })

  it('keeps a node whose parent is missing from the response', () => {
    const orphan = [node({ uid: 'lonely', kind: 'Pod', name: 'lonely', parentUid: 'gone' })]
    const { nodes } = layoutResourceGraph(orphan)

    expect(nodes).toHaveLength(1)
    expect(nodes[0].x).toBe(0)
  })

  it('handles an empty response', () => {
    expect(layoutResourceGraph([])).toEqual({
      nodes: [],
      edges: [],
      lanes: [],
      width: 0,
      height: 0,
    })
  })
})

describe('edgePath', () => {
  it('draws a straight line between cards on the same row', () => {
    const path = edgePath({
      id: 'a',
      relation: 'owns',
      fromX: 0,
      fromY: 50,
      toX: 100,
      toY: 50,
    })
    expect(path).toBe('M 0 50 H 100')
  })

  it('turns through a midpoint when the rows differ', () => {
    const path = edgePath({
      id: 'a',
      relation: 'owns',
      fromX: 0,
      fromY: 0,
      toX: 100,
      toY: 80,
    })
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
