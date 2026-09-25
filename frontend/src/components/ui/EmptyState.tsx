import type { ReactNode } from 'react'
import './EmptyState.css'

type Props = {
  title: ReactNode
  description?: ReactNode
  /** The next thing to do — every empty state should offer one. */
  action?: ReactNode
  icon?: ReactNode
  compact?: boolean
  /** Makes the title a heading, for an empty state that is the whole page (a 404). */
  titleAs?: 'h1' | 'h2' | 'h3'
}

export function EmptyState({ title, description, action, icon, compact = false, titleAs }: Props) {
  const Title = titleAs ?? 'strong'
  return (
    <div className={compact ? 'empty-state empty-state--compact' : 'empty-state'}>
      {icon && (
        <span className="empty-state-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <Title className="empty-state-title">{title}</Title>
      {description && <p className="empty-state-description">{description}</p>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  )
}
