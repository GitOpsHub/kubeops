import type { ResourceNode } from '../api/onboarding'
import { buildResourceForest, type ResourceTreeNode } from './resource-tree'
import { statusMeta } from './status'

/** Geometry for a Kubernetes topology with ownership and traffic relationships. */

/* Compact operator cards keep a five-stage topology close to 1:1 scale on a
   laptop while leaving enough height for kind, name, and state to scan cleanly. */
export const cardWidth = 248
export const cardHeight = 64
export const columnGap = 44
export const rowGap = 18

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
  /** The uids at either end, so an edge can follow its cards (e.g. dimming). */
  from: string
  to: string
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
/* The rail is part of the diagram: cards start below its stage labels. */
const laneHeaderHeight = 38

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
    return [
      {
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
      },
    ]
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
function relatedWorkloadUid(service: ResourceTreeNode, workloads: ResourceTreeNode[]) {
  const candidates = workloads.filter((workload) => workload.namespace === service.namespace)
  const serviceStem = workloadStem(service.name)
  const stemMatches = candidates.filter((workload) => workloadStem(workload.name) === serviceStem)

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
  const remainingAuxiliaries = auxiliaryNodes.filter((node) => !serviceTargets.has(node.uid))

  for (const node of routedServices) {
    const target = positionedByUid.get(serviceTargets.get(node.uid) ?? '')
    reservePosition(node, target?.y ?? laneHeaderHeight + auxiliaryRow++ * rowPitch)
  }

  for (const node of remainingAuxiliaries) {
    reservePosition(node, laneHeaderHeight + auxiliaryRow++ * rowPitch)
  }

  for (const loadBalancer of loadBalancers) {
    const service = positionedByUid.get(loadBalancer.sourceUid ?? '')
    reservePosition(loadBalancer, service?.y ?? laneHeaderHeight + auxiliaryRow++ * rowPitch)
  }

  for (const node of allNodes) {
    if (!node.parentUid) continue
    const parent = positionedByUid.get(node.parentUid)
    const child = positionedByUid.get(node.uid)
    if (!parent || !child) continue
    edges.push({
      id: `owns:${parent.uid}->${child.uid}`,
      relation: 'owns',
      from: parent.uid,
      to: child.uid,
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
      from: service.uid,
      to: workload.uid,
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
      from: loadBalancer.uid,
      to: service.uid,
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
export function edgePath(edge: Omit<GraphEdge, 'from' | 'to'>, radius = 10): string {
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
  if (['loadbalancer', 'ingress', 'gateway', 'httproute', 'service'].includes(normalized)) {
    return 'network'
  }
  if (workloadKinds.has(normalized)) return 'workload'
  if (['replicaset', 'controllerrevision'].includes(normalized)) return 'controller'
  if (normalized === 'pod') return 'pod'
  if (normalized === 'serviceaccount') return 'identity'
  return 'support'
}

/**
 * Cards in DOM order: each owner directly before what it owns, depth first,
 * and an external load balancer just before its Service. Position on the
 * canvas is absolute, so this order is what assistive technology and Tab
 * follow — it has to read as the ownership tree, not column by column.
 */
export function ownerFirstOrder(nodes: PositionedNode[]): PositionedNode[] {
  const byUid = new Map(nodes.map((node) => [node.uid, node]))
  const loadBalancers = new Map<string, PositionedNode[]>()
  for (const node of nodes) {
    if (!node.virtual || !node.sourceUid) continue
    loadBalancers.set(node.sourceUid, [...(loadBalancers.get(node.sourceUid) ?? []), node])
  }
  const ordered: PositionedNode[] = []
  const visit = (tree: ResourceTreeNode) => {
    ordered.push(...(loadBalancers.get(tree.uid) ?? []))
    const positioned = byUid.get(tree.uid)
    if (positioned) ordered.push(positioned)
    for (const child of tree.children) visit(child)
  }
  for (const root of buildResourceForest(nodes.filter((node) => !node.virtual))) visit(root)
  // Anything the forest did not reach (a load balancer whose Service is gone)
  // still gets drawn rather than silently dropped.
  const placed = new Set(ordered)
  return [...ordered, ...nodes.filter((node) => !placed.has(node))]
}

/**
 * Shortens a name from the middle. Generated names differ at the end — a
 * ReplicaSet hash, a Pod's random suffix — so an end ellipsis would hide the
 * one part that tells siblings apart.
 */
export function middleTruncate(name: string, max: number) {
  if (name.length <= max) return name
  const tail = Math.ceil((max - 1) * 0.6)
  return `${name.slice(0, max - 1 - tail)}…${name.slice(-tail)}`
}

/* Filtering for the graph ---------------------------------------------- */

/** The health buckets offered as filters, in severity-neutral reading order. */
export const healthFilterLabels = ['Healthy', 'Progressing', 'Degraded', 'Missing', 'Unknown']
export const syncFilterLabels = ['Synced', 'Out of Sync']

export type ResourceFilters = {
  /** Kinds to show; empty shows every kind. */
  kinds: string[]
  /** A canonical health label, e.g. "Degraded"; empty for any. */
  health: string
  /** A canonical sync label, e.g. "Out of Sync"; empty for any. */
  sync: string
  /** Drops the high-churn objects a Deployment owns, leaving the declared shape. */
  hideReplicaSetsAndPods: boolean
  /** Dims rather than removes, so the owner structure around a match stays readable. */
  search: string
}

export const emptyResourceFilters: ResourceFilters = {
  kinds: [],
  health: '',
  sync: '',
  hideReplicaSetsAndPods: false,
  search: '',
}

/** Resources without a health status read as Unknown, as Argo CD shows them. */
export function resourceHealthLabel(node: ResourceNode) {
  return statusMeta('health', node.healthStatus || 'Unknown').label
}

/** Empty for resources Argo CD does not track for sync, such as Pods. */
export function resourceSyncLabel(node: ResourceNode) {
  return node.syncStatus ? statusMeta('sync', node.syncStatus).label : ''
}

const churnKinds = new Set(['replicaset', 'pod'])

/** Whether anything but the dimming search is narrowing the set. */
export function hasActiveFilters(filters: ResourceFilters) {
  return (
    filters.kinds.length > 0 ||
    Boolean(filters.health) ||
    Boolean(filters.sync) ||
    filters.hideReplicaSetsAndPods
  )
}

/** Applies every filter except the search, which only dims. */
export function filterResources(nodes: ResourceNode[], filters: ResourceFilters) {
  return nodes.filter(
    (node) =>
      (filters.kinds.length === 0 || filters.kinds.includes(node.kind)) &&
      (!filters.health || resourceHealthLabel(node) === filters.health) &&
      (!filters.sync || resourceSyncLabel(node) === filters.sync) &&
      !(filters.hideReplicaSetsAndPods && churnKinds.has(normalizedKind(node.kind))),
  )
}

export function matchesResourceSearch(node: ResourceNode, query: string) {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return node.name.toLowerCase().includes(needle) || node.kind.toLowerCase().includes(needle)
}

/** Counts per label, e.g. how many resources are Degraded. */
export function countBy(nodes: ResourceNode[], label: (node: ResourceNode) => string) {
  const counts = new Map<string, number>()
  for (const node of nodes) {
    const key = label(node)
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

// Argo CD's per-node info rows carry the reason a Pod is unhealthy, e.g.
// "Status Reason: CrashLoopBackOff".
const reasonRows = new Set(['status reason', 'reason', 'message'])

/**
 * The line a card shows under its name when something needs attention: the
 * canonical health label, plus the reason when Argo CD reports one. Healthy,
 * suspended, and unknown resources get none, so the line itself is a signal.
 */
export function resourceStatusMessage(node: ResourceNode) {
  const meta = statusMeta('health', node.healthStatus)
  if (meta.tone !== 'err' && meta.tone !== 'warn' && !meta.inFlight) return ''
  const reason = node.info?.find((row) => reasonRows.has(row.name.toLowerCase()))?.value
  return reason ? `${meta.label} · ${reason}` : meta.label
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
