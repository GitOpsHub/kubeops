import type { ReactNode } from 'react'
import './Tooltip.css'

type Props = {
  content: ReactNode
  side?: 'right' | 'top' | 'bottom'
  /** Lets a caller switch the tooltip off, e.g. while the label is visible. */
  disabled?: boolean
  children: ReactNode
}

/**
 * A hover-and-focus hint drawn in CSS. It is decorative: the wrapped control
 * must already carry its own accessible name, so the tooltip repeats rather
 * than replaces it and stays out of the accessibility tree.
 */
export function Tooltip({ content, side = 'top', disabled = false, children }: Props) {
  if (disabled) return <>{children}</>
  return (
    <span className={`tooltip-anchor tooltip-anchor--${side}`}>
      {children}
      <span className="tooltip" aria-hidden="true">
        {content}
      </span>
    </span>
  )
}
