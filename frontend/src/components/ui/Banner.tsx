import type { ReactNode } from 'react'
import './Banner.css'

import type { Tone as StatusTone } from '../../lib/status'

type Tone = 'error' | 'warn' | 'info' | 'success'

const statusTones: Record<Tone, StatusTone> = {
  error: 'err',
  warn: 'warn',
  info: 'info',
  success: 'ok',
}

type Props = {
  tone?: Tone
  title: ReactNode
  children?: ReactNode
  onRetry?: () => void
  retryLabel?: string
  onDismiss?: () => void
  className?: string
}

const icons: Record<Tone, string> = {
  error: 'M8 5v3.5M8 11h.01M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0Z',
  warn: 'M8 6v3M8 11.5h.01M7.1 2.6 1.8 12a1 1 0 0 0 .9 1.5h10.6a1 1 0 0 0 .9-1.5L8.9 2.6a1 1 0 0 0-1.8 0Z',
  info: 'M8 7.5V11M8 5h.01M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0Z',
  success: 'm5.5 8.2 1.8 1.8 3.3-3.6M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0Z',
}

/**
 * Inline feedback. Errors announce as alerts; everything else is a polite
 * status, so a success message never interrupts a screen reader mid-sentence.
 */
export function Banner({
  tone = 'info',
  title,
  children,
  onRetry,
  retryLabel = 'Try again',
  onDismiss,
  className = '',
}: Props) {
  return (
    <div
      className={`banner banner--${tone} ${className}`.trim()}
      role={tone === 'error' ? 'alert' : 'status'}
      data-tone={statusTones[tone]}
    >
      <svg className="banner-icon" viewBox="0 0 16 16" aria-hidden="true">
        <path d={icons[tone]} />
      </svg>
      <div className="banner-copy">
        <strong>{title}</strong>
        {children && <span>{children}</span>}
      </div>
      {(onRetry || onDismiss) && (
        <div className="banner-actions">
          {onRetry && (
            <button type="button" className="link-button" onClick={onRetry}>
              {retryLabel}
            </button>
          )}
          {onDismiss && (
            <button type="button" className="link-button" onClick={onDismiss}>
              Dismiss
            </button>
          )}
        </div>
      )}
    </div>
  )
}
