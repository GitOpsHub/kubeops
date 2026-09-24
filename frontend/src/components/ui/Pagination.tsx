import { ChevronLeftIcon, ChevronRightIcon } from '../icons'
import { Button } from './Button'
import './Pagination.css'

type Props = {
  /** One-based. */
  page: number
  pageSize: number
  total: number
  pageSizeOptions: number[]
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
  /** What is being paged, singular and plural: ['cluster', 'clusters']. */
  noun: [singular: string, plural: string]
  /**
   * `pages` reads "Page 2 of 5 · 112 clusters", for server-paged lists where
   * the position matters; `range` reads "Showing 26–50 of 60 applications".
   */
  summary?: 'pages' | 'range'
  /** Accessible name of the page-size select, e.g. "Clusters per page". */
  pageSizeLabel: string
  /** Names the navigation landmark. */
  label?: string
}

function paginationSummary({
  page,
  pageSize,
  total,
  noun,
  summary = 'pages',
}: Pick<Props, 'page' | 'pageSize' | 'total' | 'noun' | 'summary'>) {
  const [singular, plural] = noun
  const counted = `${total} ${total === 1 ? singular : plural}`
  if (summary === 'pages') {
    const pages = Math.max(1, Math.ceil(total / pageSize))
    return `Page ${page} of ${pages} · ${counted}`
  }
  if (total === 0) return `No ${plural}`
  const first = (page - 1) * pageSize + 1
  const last = Math.min(page * pageSize, total)
  return `Showing ${first}–${last} of ${counted}`
}

/** The footer under a paged table: where you are, rows per page, and previous/next. */
export function Pagination({
  page,
  pageSize,
  total,
  pageSizeOptions,
  onPageChange,
  onPageSizeChange,
  noun,
  summary = 'pages',
  pageSizeLabel,
  label = 'Pagination',
}: Props) {
  const pages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <nav className="table-footer pagination" aria-label={label}>
      <span className="pagination-summary">
        {paginationSummary({ page, pageSize, total, noun, summary })}
      </span>
      <div className="table-footer-controls">
        <label className="pagination-size">
          <span aria-hidden="true">Rows</span>
          <select
            className="select"
            aria-label={pageSizeLabel}
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
          >
            {pageSizeOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <Button
          size="sm"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          icon={<ChevronLeftIcon />}
        >
          Previous
        </Button>
        <Button size="sm" disabled={page >= pages} onClick={() => onPageChange(page + 1)}>
          Next
          <ChevronRightIcon />
        </Button>
      </div>
    </nav>
  )
}
