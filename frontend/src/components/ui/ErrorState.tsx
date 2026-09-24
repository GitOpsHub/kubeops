import type { ReactNode } from 'react'
import { ErrorIcon } from '../icons'
import { Button } from './Button'
import './EmptyState.css'

type Props = {
  title?: ReactNode
  /** What went wrong, usually the API's message. */
  message?: ReactNode
  onRetry?: () => void
  retryLabel?: string
  compact?: boolean
}

/**
 * The failure counterpart to `EmptyState`: said as an alert, with a way to
 * try again. For a failure that leaves stale content on screen, prefer a
 * `Banner` above that content instead.
 */
export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
  retryLabel = 'Try again',
  compact = false,
}: Props) {
  return (
    <div
      className={compact ? 'empty-state empty-state--compact' : 'empty-state'}
      data-tone="err"
      role="alert"
    >
      <span className="empty-state-icon empty-state-icon--tone" aria-hidden="true">
        <ErrorIcon />
      </span>
      <strong className="empty-state-title">{title}</strong>
      {message && <p className="empty-state-description">{message}</p>}
      {onRetry && (
        <div className="empty-state-action">
          <Button size="sm" onClick={onRetry}>
            {retryLabel}
          </Button>
        </div>
      )}
    </div>
  )
}
