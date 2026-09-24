import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { Tone } from '../../lib/status'
import './StatCard.css'

type Props = {
  label: string
  value: ReactNode
  hint?: ReactNode
  tone?: Tone
  icon?: ReactNode
  /** Makes the whole card a link to where the number is explained. */
  to?: string
  /** Replaces the computed accessible name when the visible text is terse. */
  'aria-label'?: string
  children?: ReactNode
}

export function StatCard({ label, value, hint, tone, icon, to, children, ...rest }: Props) {
  const body = (
    <>
      <span className="stat-card-label">
        {icon && (
          <span className="stat-card-icon" aria-hidden="true">
            {icon}
          </span>
        )}
        {label}
      </span>
      <strong className="stat-card-value">{value}</strong>
      {hint && <span className="stat-card-hint">{hint}</span>}
      {children}
    </>
  )
  const className = `stat-card${tone ? ` stat-card--${tone}` : ''}`
  return to ? (
    <Link
      className={`${className} stat-card--link`}
      to={to}
      aria-label={rest['aria-label']}
      data-tone={tone}
    >
      {body}
    </Link>
  ) : (
    <div
      className={className}
      data-tone={tone}
      aria-label={rest['aria-label']}
      role={rest['aria-label'] ? 'group' : undefined}
    >
      {body}
    </div>
  )
}
