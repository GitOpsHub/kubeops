export type SortDirection = 'asc' | 'desc'

/** The `aria-sort` value for a column header. */
export function sortState(active: boolean, direction: SortDirection) {
  if (!active) return 'none' as const
  return direction === 'asc' ? ('ascending' as const) : ('descending' as const)
}
