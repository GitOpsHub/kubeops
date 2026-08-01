import type { ResourceNode, ResourceRef } from '../api/onboarding'

/**
 * Argo CD returns the resource tree as a flat list where each node points at
 * its owner, so the hierarchy (Deployment → ReplicaSet → Pod) has to be rebuilt
 * before it can be rendered.
 */

export type ResourceTreeNode = ResourceNode & {
  depth: number
  children: ResourceTreeNode[]
}

export function resourceKey(ref: ResourceRef) {
  return `${ref.group}/${ref.kind}/${ref.namespace}/${ref.name}`
}

function compare(a: ResourceNode, b: ResourceNode) {
  return a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)
}

/**
 * Rebuilds the forest, with every node's children sorted and its depth set. A
 * node whose parent is missing from the response is treated as a root so
 * nothing is silently dropped.
 */
export function buildResourceForest(nodes: ResourceNode[]): ResourceTreeNode[] {
  const byUid = new Map<string, ResourceTreeNode>()
  for (const node of nodes) {
    byUid.set(node.uid, { ...node, depth: 0, children: [] })
  }

  const roots: ResourceTreeNode[] = []
  for (const node of byUid.values()) {
    const parent = node.parentUid ? byUid.get(node.parentUid) : undefined
    if (parent && parent !== node) parent.children.push(node)
    else roots.push(node)
  }

  const setDepth = (node: ResourceTreeNode, depth: number) => {
    node.depth = depth
    node.children.sort(compare)
    for (const child of node.children) setDepth(child, depth + 1)
  }
  roots.sort(compare)
  for (const root of roots) setDepth(root, 0)
  return roots
}

/**
 * Flattens the forest depth-first. This is the order resources are placed in
 * the DOM in both views, so an owner always precedes the objects it owns.
 */
export function buildResourceTree(nodes: ResourceNode[]): ResourceTreeNode[] {
  const flattened: ResourceTreeNode[] = []
  const visit = (node: ResourceTreeNode) => {
    flattened.push(node)
    for (const child of node.children) visit(child)
  }
  for (const root of buildResourceForest(nodes)) visit(root)
  return flattened
}

/** Compact age such as "3d" or "12m", from a resource's creation timestamp. */
export function age(createdAt: string, now = Date.now()) {
  if (!createdAt) return '—'
  const created = new Date(createdAt).getTime()
  if (Number.isNaN(created)) return '—'
  const seconds = Math.max(0, Math.round((now - created) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/**
 * Conversational age for a lifecycle event, such as "12m ago". Anything older
 * than a month reads as a date instead, where "43d ago" stops being useful.
 */
export function relativeTime(value: string, now = Date.now()) {
  const at = new Date(value).getTime()
  if (Number.isNaN(at)) return ''
  const seconds = Math.round((now - at) / 1000)
  if (seconds < 0) return 'scheduled'
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days <= 30) return `${days}d ago`
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
