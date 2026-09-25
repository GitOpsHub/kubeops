import { Fragment, type KeyboardEvent, type ReactNode } from 'react'
import { sortState, type SortDirection } from './table-sort'
import './DataTable.css'

export type { SortDirection }

export type Column<T> = {
  id: string
  header: ReactNode
  cell: (row: T) => ReactNode
  /** Makes the header a sort button; the table stays controlled by the caller. */
  sortable?: boolean
  align?: 'start' | 'end'
  className?: string
  /** Header-only accessible name, for columns with no visible header. */
  headerLabel?: string
}

type Props<T> = {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string
  label: string
  sort?: { column: string; direction: SortDirection }
  onSort?: (column: string) => void
  /**
   * Makes each row focusable and activatable with Enter or Space as well as a
   * click, so a row that opens something is not mouse-only.
   */
  onRowClick?: (row: T) => void
  /**
   * Turn off when every row already holds a button to the same place, so the
   * keyboard path is one tab stop per row rather than two.
   */
  focusableRows?: boolean
  rowClassName?: (row: T) => string
  /** Accessible name for an activatable row. */
  rowLabel?: (row: T) => string
  /**
   * Detail drawn in a full-width row under its parent, e.g. a nested table.
   * Return null for a collapsed row; the caller owns which rows are open.
   */
  renderExpanded?: (row: T) => ReactNode
  /** Id of the expanded row, for the toggle's `aria-controls`. */
  expandedRowId?: (row: T) => string
  className?: string
}

export function SortCaret({ active, direction }: { active: boolean; direction: SortDirection }) {
  return (
    <svg
      className={active ? 'sort-caret is-active' : 'sort-caret'}
      viewBox="0 0 10 14"
      aria-hidden="true"
    >
      <path className={active && direction === 'asc' ? 'is-on' : ''} d="M2 5.5 5 2.5l3 3" />
      <path className={active && direction === 'desc' ? 'is-on' : ''} d="M2 8.5l3 3 3-3" />
    </svg>
  )
}

/**
 * A plain semantic table with a sticky header, horizontal scroll inside its own
 * frame, and optional sortable headers. Sorting stays with the caller so the
 * sort state can live wherever the page keeps it (the URL, local state).
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  label,
  sort,
  onSort,
  onRowClick,
  focusableRows = true,
  rowClassName,
  rowLabel,
  renderExpanded,
  expandedRowId,
  className = '',
}: Props<T>) {
  const rowFocus = Boolean(onRowClick) && focusableRows

  function handleKeyDown(event: KeyboardEvent<HTMLTableRowElement>, row: T) {
    // Only the row itself: a key press on a button inside it is that button's.
    if (event.target !== event.currentTarget) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onRowClick?.(row)
    }
  }

  return (
    <div className={`table-scroll ${className}`.trim()}>
      <table className="data-table" aria-label={label}>
        <thead>
          <tr>
            {columns.map((column) => {
              const active = sort?.column === column.id
              return (
                <th
                  key={column.id}
                  scope="col"
                  className={
                    `${column.className ?? ''}${column.align === 'end' ? ' is-end' : ''}`.trim() ||
                    undefined
                  }
                  aria-sort={
                    column.sortable && sort ? sortState(active, sort.direction) : undefined
                  }
                >
                  {/* Real text, not aria-label: an empty header cell reads as
                      a missing header to screen readers and to axe. */}
                  {column.headerLabel && <span className="sr-only">{column.headerLabel}</span>}
                  {column.sortable && onSort ? (
                    <button type="button" className="column-sort" onClick={() => onSort(column.id)}>
                      {column.header}
                      <SortCaret active={active} direction={sort?.direction ?? 'asc'} />
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row)
            const expanded = renderExpanded?.(row)
            return (
              <Fragment key={key}>
                <tr
                  className={
                    `${onRowClick ? 'is-clickable ' : ''}${rowClassName?.(row) ?? ''}`.trim() ||
                    undefined
                  }
                  tabIndex={rowFocus ? 0 : undefined}
                  aria-label={rowFocus ? rowLabel?.(row) : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={rowFocus ? (event) => handleKeyDown(event, row) : undefined}
                >
                  {columns.map((column) => (
                    <td
                      key={column.id}
                      className={
                        `${column.className ?? ''}${column.align === 'end' ? ' is-end' : ''}`.trim() ||
                        undefined
                      }
                    >
                      {column.cell(row)}
                    </td>
                  ))}
                </tr>
                {expanded != null && expanded !== false && (
                  <tr className="expanded-row" id={expandedRowId?.(row)}>
                    <td colSpan={columns.length}>{expanded}</td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
