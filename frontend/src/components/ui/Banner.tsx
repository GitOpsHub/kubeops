import type { ReactNode } from 'react'
import { ErrorIcon, InfoIcon, SuccessIcon, WarningIcon } from '../icons'
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

const icons: Record<Tone, ReactNode> = {
  error: <ErrorIcon />,
  warn: <WarningIcon />,
  info: <InfoIcon />,
  success: <SuccessIcon />,
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
      <span className="banner-icon" aria-hidden="true">
        {icons[tone]}
      </span>
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
