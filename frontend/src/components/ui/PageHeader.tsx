import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import './PageHeader.css'

type Props = {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  /** A small line of context under the actions, e.g. a refresh indicator. */
  meta?: ReactNode
  back?: { to: string; label: string }
  /** Lets a page point `aria-labelledby` at its heading. */
  id?: string
  leading?: ReactNode
}

export function PageHeader({ title, description, actions, meta, back, id, leading }: Props) {
  return (
    <header className="page-header">
      {back && (
        <Link className="page-back" to={back.to}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M10 3.5 5.5 8l4.5 4.5" />
          </svg>
          {back.label}
        </Link>
      )}
      <div className="page-header-row">
        <div className="page-header-identity">
          {leading}
          <div className="page-header-copy">
            <h1 id={id}>{title}</h1>
            {description && <p className="page-description">{description}</p>}
          </div>
        </div>
        {(actions || meta) && (
          <div className="page-header-side">
            {actions && <div className="page-actions">{actions}</div>}
            {meta && <div className="page-meta">{meta}</div>}
          </div>
        )}
      </div>
    </header>
  )
}
