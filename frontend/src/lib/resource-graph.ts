import type { ResourceNode } from '../api/onboarding'
import { buildResourceForest, type ResourceTreeNode } from './resource-tree'

/** Geometry for a Kubernetes topology with ownership and traffic relationships. */

/* Argo CD's tree draws each object as a wide, short pill rather than a tile, so
   a long Kubernetes name fits on one line and a deep ownership chain stays
   readable without scrolling vertically. */
export const cardWidth = 282
export const cardHeight = 52
export const columnGap = 60
export const rowGap = 14

type GraphResourceNode = ResourceTreeNode & {
  virtual?: boolean
  sourceUid?: string
}

export type PositionedNode = GraphResourceNode & {
  x: number
  y: number
}

export type GraphEdge = {
  id: string
  relation: 'owns' | 'routes'
  fromX: number
  fromY: number
  toX: number
  toY: number
}

export type GraphLane = {
  id: string
  label: string
  x: number
}

export type ResourceGraphLayout = {
  nodes: PositionedNode[]
  edges: GraphEdge[]
  lanes: GraphLane[]
  width: number
  height: number
}

const rowPitch = cardHeight + rowGap
const columnPitch = cardWidth + columnGap
/* Lanes still drive the x maths, but they are no longer drawn as a labelled
   header rail, so the first row starts at the top of the canvas. */
const laneHeaderHeight = 0

const laneByKind: Record<string, number> = {
  loadbalancer: 0,
  ingress: 0,
  gateway: 0,
  httproute: 0,
  service: 1,
  serviceaccount: 1,
  configmap: 1,
  secret: 1,
  persistentvolumeclaim: 1,
  deployment: 2,
  statefulset: 2,
  daemonset: 2,
  job: 2,
  cronjob: 2,
  rollout: 2,
  replicaset: 3,
  controllerrevision: 3,
  pod: 4,
}

const laneLabels: Record<number, string> = {
  0: 'Entry',
  1: 'Network & identity',
  2: 'Workloads',
  3: 'Controllers',
  4: 'Pods',
}

const auxiliaryKinds = new Set([
  'loadbalancer',
  'ingress',
  'gateway',
  'httproute',
  'service',
  'serviceaccount',
  'configmap',
  'secret',
  'persistentvolumeclaim',
])

const workloadKinds = new Set([
  'deployment',
  'statefulset',
  'daemonset',
  'job',
  'cronjob',
  'rollout',
])

function normalizedKind(kind: string) {
  return kind.toLowerCase()
}

function semanticLane(node: GraphResourceNode): number {
  const explicit = laneByKind[normalizedKind(node.kind)]
  if (explicit !== undefined) return explicit
  return Math.min(4, node.depth + 2)
}

/**
 * Assigns each node a row. Leaves consume the next free row; a parent takes the
 * midpoint between its first and last child so the connector fan is symmetric.
 * Returns rows as fractional slot indices, converted to pixels by the caller.
 */
function assignRows(roots: ResourceTreeNode[]) {
  const rows = new Map<string, number>()
  let nextLeafRow = 0

  const visit = (node: ResourceTreeNode): number => {
    if (node.children.length === 0) {
      const row = nextLeafRow
      nextLeafRow += 1
      rows.set(node.uid, row)
      return row
    }
    const childRows = node.children.map(visit)
    const row = (childRows[0] + childRows[childRows.length - 1]) / 2
    rows.set(node.uid, row)
    return row
  }

  for (const root of roots) visit(root)
  return { rows, nextLeafRow }
}

function flatten(roots: ResourceTreeNode[]) {
  const flattened: ResourceTreeNode[] = []
  const visit = (node: ResourceTreeNode) => {
    flattened.push(node)
    for (const child of node.children) visit(child)
  }
  for (const root of roots) visit(root)
  return flattened
}

function externalLoadBalancers(nodes: ResourceTreeNode[]): GraphResourceNode[] {
  return nodes.flatMap((node) => {
    if (
      normalizedKind(node.kind) !== 'service' ||
      normalizedKind(node.exposure?.type ?? '') !== 'loadbalancer'
    ) {
      return []
    }
    const address = node.exposure?.addresses[0]
    return [{
      ...node,
      group: 'kubeops.io',
      version: 'v1',
      kind: 'LoadBalancer',
      name: address || 'Pending external address',
      uid: `external-load-balancer:${node.uid}`,
      parentUid: '',
      healthStatus: address ? 'Healthy' : 'Progressing',
      syncStatus: '',
      images: [],
      info: [
        { name: 'Managed by', value: 'Cloud provider' },
        ...(node.exposure?.ports?.length
          ? [{ name: 'Ports', value: node.exposure.ports.join(', ') }]
          : []),
      ],
      children: [],
      depth: 0,
      virtual: true as const,
      sourceUid: node.uid,
    }]
  })
}

function workloadStem(name: string) {
  return name
    .toLowerCase()
    .replace(
      /-(deployment|statefulset|daemonset|service-account|serviceaccount|service|svc|workload)$/,
      '',
    )
}

/**
 * The resource payload does not include Service selectors, so traffic-to-workload
 * links use a deliberately conservative summary: a matching namespace and name
 * stem, or the namespace's only workload when there is no ambiguity.
 */
function relatedWorkloadUid(
  service: ResourceTreeNode,
  workloads: ResourceTreeNode[],
) {
  const candidates = workloads.filter(
    (workload) => workload.namespace === service.namespace,
  )
  const serviceStem = workloadStem(service.name)
  const stemMatches = candidates.filter(
    (workload) => workloadStem(workload.name) === serviceStem,
  )

  if (stemMatches.length === 1) return stemMatches[0].uid
  if (candidates.length === 1) return candidates[0].uid
  return undefined
}

export function layoutResourceGraph(nodes: ResourceNode[]): ResourceGraphLayout {
  if (nodes.length === 0) {
    return { nodes: [], edges: [], lanes: [], width: 0, height: 0 }
  }

  const roots = buildResourceForest(nodes)
  const allNodes = flatten(roots)
  const loadBalancers = externalLoadBalancers(allNodes)
  const graphNodes = [...allNodes, ...loadBalancers]
  const structuralRoots = roots.filter(
    (node) => !auxiliaryKinds.has(normalizedKind(node.kind)) || node.children.length > 0,
  )
  const workloads = allNodes.filter((node) => workloadKinds.has(normalizedKind(node.kind)))
  const serviceTargets = new Map(
    allNodes
      .filter((node) => normalizedKind(node.kind) === 'service')
      .flatMap((service) => {
        const targetUid = relatedWorkloadUid(service, workloads)
        return targetUid ? [[service.uid, targetUid] as const] : []
      }),
  )
  const { rows, nextLeafRow } = assignRows(structuralRoots)
  const usedRawLanes = [...new Set(graphNodes.map(semanticLane))].sort((a, b) => a - b)
  const minimumLane = usedRawLanes[0] ?? 0
  const laneX = (rawLane: number) => (rawLane - minimumLane) * columnPitch

  const positioned: PositionedNode[] = []
  const edges: GraphEdge[] = []
  const positionedByUid = new Map<string, PositionedNode>()
  const occupiedByLane = new Map<number, number[]>()

  const reservePosition = (node: GraphResourceNode, desiredY: number) => {
    const rawLane = semanticLane(node)
    const occupied = occupiedByLane.get(rawLane) ?? []
    let y = desiredY
    while (occupied.some((existingY) => Math.abs(existingY - y) < cardHeight + rowGap)) {
      y += rowPitch
    }
    occupied.push(y)
    occupiedByLane.set(rawLane, occupied)

    const item = { ...node, x: laneX(rawLane), y }
    positioned.push(item)
    positionedByUid.set(node.uid, item)
  }

  const visit = (node: ResourceTreeNode) => {
    reservePosition(node, laneHeaderHeight + (rows.get(node.uid) ?? 0) * rowPitch)
    for (const child of node.children) {
      visit(child)
    }
  }
  for (const root of structuralRoots) visit(root)

  let auxiliaryRow = nextLeafRow

  const auxiliaryNodes = allNodes.filter((node) => !positionedByUid.has(node.uid))
  const routedServices = auxiliaryNodes.filter((node) => serviceTargets.has(node.uid))
  const remainingAuxiliaries = auxiliaryNodes.filter(
    (node) => !serviceTargets.has(node.uid),
  )

  for (const node of routedServices) {
    const target = positionedByUid.get(serviceTargets.get(node.uid) ?? '')
    reservePosition(node, target?.y ?? laneHeaderHeight + auxiliaryRow++ * rowPitch)
  }

  for (const node of remainingAuxiliaries) {
    reservePosition(node, laneHeaderHeight + auxiliaryRow++ * rowPitch)
  }

  for (const loadBalancer of loadBalancers) {
    const service = positionedByUid.get(loadBalancer.sourceUid ?? '')
    reservePosition(
      loadBalancer,
      service?.y ?? laneHeaderHeight + auxiliaryRow++ * rowPitch,
    )
  }

  for (const node of allNodes) {
    if (!node.parentUid) continue
    const parent = positionedByUid.get(node.parentUid)
    const child = positionedByUid.get(node.uid)
    if (!parent || !child) continue
    edges.push({
      id: `owns:${parent.uid}->${child.uid}`,
      relation: 'owns',
      fromX: parent.x + cardWidth,
      fromY: parent.y + cardHeight / 2,
      toX: child.x,
      toY: child.y + cardHeight / 2,
    })
  }

  for (const [serviceUid, workloadUid] of serviceTargets) {
    const service = positionedByUid.get(serviceUid)
    const workload = positionedByUid.get(workloadUid)
    if (!service || !workload) continue
    edges.push({
      id: `routes:${service.uid}->${workload.uid}`,
      relation: 'routes',
      fromX: service.x + cardWidth,
      fromY: service.y + cardHeight / 2,
      toX: workload.x,
      toY: workload.y + cardHeight / 2,
    })
  }

  for (const loadBalancer of loadBalancers) {
    const service = positionedByUid.get(loadBalancer.sourceUid ?? '')
    const positionedLoadBalancer = positionedByUid.get(loadBalancer.uid)
    if (!service || !positionedLoadBalancer) continue
    edges.push({
      id: `routes:${loadBalancer.uid}->${service.uid}`,
      relation: 'routes',
      fromX: positionedLoadBalancer.x + cardWidth,
      fromY: positionedLoadBalancer.y + cardHeight / 2,
      toX: service.x,
      toY: service.y + cardHeight / 2,
    })
  }

  positioned.sort((a, b) => a.x - b.x || a.y - b.y || a.name.localeCompare(b.name))

  // The canvas has to bound every card, not just the deepest column, or the
  // last row clips when the container scrolls.
  const width = positioned.reduce((max, node) => Math.max(max, node.x + cardWidth), 0)
  const height = positioned.reduce((max, node) => Math.max(max, node.y + cardHeight), 0)
  const lanes = usedRawLanes.map((rawLane) => ({
    id: String(rawLane),
    label: laneLabels[rawLane] ?? 'Resources',
    x: laneX(rawLane),
  }))

  return { nodes: positioned, edges, lanes, width, height }
}

/**
 * An orthogonal connector: out of the parent, across to a midpoint, down or up
 * to the child's row, then into the child. The quarter-circle corners keep it
 * from reading as a hard schematic.
 */
export function edgePath(edge: GraphEdge, radius = 10): string {
  const midX = edge.fromX + (edge.toX - edge.fromX) / 2
  if (Math.abs(edge.toY - edge.fromY) < 1) {
    return `M ${edge.fromX} ${edge.fromY} H ${edge.toX}`
  }
  const down = edge.toY > edge.fromY
  const sweepIn = down ? 1 : 0
  const sweepOut = down ? 0 : 1
  const corner = Math.min(radius, Math.abs(edge.toY - edge.fromY) / 2)
  const beforeCorner = down ? edge.fromY + corner : edge.fromY - corner
  const afterCorner = down ? edge.toY - corner : edge.toY + corner

  return [
    `M ${edge.fromX} ${edge.fromY}`,
    `H ${midX - corner}`,
    `A ${corner} ${corner} 0 0 ${sweepIn} ${midX} ${beforeCorner}`,
    `V ${afterCorner}`,
    `A ${corner} ${corner} 0 0 ${sweepOut} ${midX + corner} ${edge.toY}`,
    `H ${edge.toX}`,
  ].join(' ')
}

export function resourceCategory(kind: string) {
  const normalized = normalizedKind(kind)
  if (
    ['loadbalancer', 'ingress', 'gateway', 'httproute', 'service'].includes(normalized)
  ) {
    return 'network'
  }
  if (workloadKinds.has(normalized)) return 'workload'
  if (['replicaset', 'controllerrevision'].includes(normalized)) return 'controller'
  if (normalized === 'pod') return 'pod'
  if (normalized === 'serviceaccount') return 'identity'
  return 'support'
}

/* Sorting for the list view ------------------------------------------- */

export type SortColumn = 'kind' | 'name' | 'namespace' | 'healthStatus' | 'syncStatus' | 'createdAt'
export type SortDirection = 'asc' | 'desc'

/**
 * Sorts a flat resource list. Age sorts by real timestamp rather than by the
 * formatted label, so "9m" never lands next to "9d".
 */
export function sortResources(
  nodes: ResourceNode[],
  column: SortColumn,
  direction: SortDirection,
): ResourceNode[] {
  const factor = direction === 'asc' ? 1 : -1
  return [...nodes].sort((a, b) => {
    const compared =
      column === 'createdAt'
        ? (new Date(a.createdAt).getTime() || 0) - (new Date(b.createdAt).getTime() || 0)
        : String(a[column] ?? '').localeCompare(String(b[column] ?? ''))
    if (compared !== 0) return compared * factor
    // The tie-break stays ascending whichever way the column sorts: reversing
    // it too would shuffle every pod of the same kind on each toggle.
    return a.name.localeCompare(b.name)
  })
}
