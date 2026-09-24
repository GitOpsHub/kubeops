import { SkeletonCards, SkeletonRows } from './Skeleton'
import './LoadingState.css'

type Props = {
  /** Announced once, and shown beside the spinner. */
  label?: string
  /** Placeholder shaped like what is coming: table rows, cards, or nothing. */
  shape?: 'rows' | 'cards' | 'none'
  rows?: number
  columns?: number
}

/**
 * One loading treatment: a polite status with the label, over skeletons
 * shaped like the content, so the layout does not jump when it arrives.
 */
export function LoadingState({ label = 'Loading…', shape = 'rows', rows = 6, columns = 5 }: Props) {
  return (
    <div className="loading-state" role="status">
      <span className="loading-state-label">
        <span className="spinner" aria-hidden="true" />
        {label}
      </span>
      {shape === 'rows' && <SkeletonRows rows={rows} columns={columns} />}
      {shape === 'cards' && <SkeletonCards count={rows} />}
    </div>
  )
}
