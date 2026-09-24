import type { ReactNode } from 'react'
import './EmptyState.css'

type Props = {
  title: ReactNode
  description?: ReactNode
  /** The next thing to do — every empty state should offer one. */
  action?: ReactNode
  icon?: ReactNode
  compact?: boolean
}

export function EmptyState({ title, description, action, icon, compact = false }: Props) {
  return (
    <div className={compact ? 'empty-state empty-state--compact' : 'empty-state'}>
      {icon && (
        <span className="empty-state-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <strong className="empty-state-title">{title}</strong>
      {description && <p className="empty-state-description">{description}</p>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  )
}
