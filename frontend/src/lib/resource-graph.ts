import type { ResourceNode } from '../api/onboarding'
import { buildResourceForest, type ResourceTreeNode } from './resource-tree'

/**
 * Geometry for the horizontal resource graph. Kept free of React and the DOM so
 * the layout can be reasoned about and tested on its own — the components only
 * paint what this returns.
 *
 * Columns are depth: a Deployment sits left of its ReplicaSet, which sits left
 * of its Pods. Rows are assigned so that every leaf gets its own slot and each
 * parent centres on the block of children it owns.
 */

export const cardWidth = 216
export const cardHeight = 104
export const columnGap = 56
export const rowGap = 16

export type PositionedNode = ResourceTreeNode & {
  x: number
  y: number
}

export type GraphEdge = {
  id: string
  /** Right edge of the parent, vertically centred. */
  fromX: number
  fromY: number
  /** Left edge of the child, vertically centred. */
  toX: number
  toY: number
}

export type ResourceGraphLayout = {
  nodes: PositionedNode[]
  edges: GraphEdge[]
  width: number
  height: number
}

const rowPitch = cardHeight + rowGap
const columnPitch = cardWidth + columnGap

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
  return rows
}

export function layoutResourceGraph(nodes: ResourceNode[]): ResourceGraphLayout {
  const roots = buildResourceForest(nodes)
  const rows = assignRows(roots)

  const positioned: PositionedNode[] = []
  const edges: GraphEdge[] = []

  const visit = (node: ResourceTreeNode) => {
    const x = node.depth * columnPitch
    const y = (rows.get(node.uid) ?? 0) * rowPitch
    positioned.push({ ...node, x, y })

    for (const child of node.children) {
      const childY = (rows.get(child.uid) ?? 0) * rowPitch
      edges.push({
        id: `${node.uid}->${child.uid}`,
        fromX: x + cardWidth,
        fromY: y + cardHeight / 2,
        toX: (child.depth ?? node.depth + 1) * columnPitch,
        toY: childY + cardHeight / 2,
      })
      visit(child)
    }
  }
  for (const root of roots) visit(root)

  // The canvas has to bound every card, not just the deepest column, or the
  // last row clips when the container scrolls.
  const width = positioned.reduce((max, node) => Math.max(max, node.x + cardWidth), 0)
  const height = positioned.reduce((max, node) => Math.max(max, node.y + cardHeight), 0)

  return { nodes: positioned, edges, width, height }
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
