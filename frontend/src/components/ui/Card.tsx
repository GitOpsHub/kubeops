import { useId, type HTMLAttributes, type ReactNode } from 'react'
import './Card.css'

type Props = Omit<HTMLAttributes<HTMLElement>, 'title'> & {
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  /** Heading level for the title; defaults to h2. */
  level?: 2 | 3
  /** Drop the body padding for flush content such as a table. */
  flush?: boolean
  as?: 'section' | 'div' | 'article'
}

export function Card({
  title,
  description,
  actions,
  level = 2,
  flush = false,
  as: Element = 'section',
  className = '',
  children,
  ...rest
}: Props) {
  const Heading = level === 2 ? 'h2' : 'h3'
  const titleId = useId()
  return (
    <Element
      className={`card ${className}`.trim()}
      aria-labelledby={title ? titleId : undefined}
      {...rest}
    >
      {(title || actions) && (
        <header className="card-header">
          <div className="card-heading">
            {title && (
              <Heading className="card-title" id={titleId}>
                {title}
              </Heading>
            )}
            {description && <p className="card-description">{description}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className={flush ? 'card-body card-body--flush' : 'card-body'}>{children}</div>
    </Element>
  )
}
