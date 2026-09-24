import type { ReactNode } from 'react'
import { CloseIcon } from '../icons'
import { Button } from './Button'
import { DialogClose, DialogDescription, DialogTitle } from './Dialog'

type HeaderProps = {
  title: ReactNode
  /** A short eyebrow above the title, e.g. "Destructive action". */
  kicker?: ReactNode
  /** Rendered as the dialog's accessible description. */
  description?: ReactNode
  /** A mark beside the title, e.g. a warning glyph. */
  icon?: ReactNode
  /** Extra controls on the right, before the close button. */
  actions?: ReactNode
  /** Names the close button; omit it to render no close button. */
  closeLabel?: string
  className?: string
}

/**
 * The top of every dialog: title (always wired to Radix, which requires one),
 * optional kicker and description, and an optional close button. The class
 * names are the ones Dialog.css already styles, so migrated dialogs keep
 * their look.
 */
export function DialogHeader({
  title,
  kicker,
  description,
  icon,
  actions,
  closeLabel,
  className = '',
}: HeaderProps) {
  return (
    <header className={`dialog-header ${className}`.trim()}>
      {icon && (
        <span className="dialog-header-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <div className="dialog-title-group">
        {kicker && <p className="kicker">{kicker}</p>}
        <DialogTitle asChild>
          <h2>{title}</h2>
        </DialogTitle>
        {description && (
          <DialogDescription asChild>
            <p className="dialog-description">{description}</p>
          </DialogDescription>
        )}
      </div>
      {(actions || closeLabel) && (
        <div className="dialog-header-actions">
          {actions}
          {closeLabel && (
            <DialogClose asChild>
              <Button variant="ghost" size="sm" iconOnly aria-label={closeLabel}>
                <CloseIcon />
              </Button>
            </DialogClose>
          )}
        </div>
      )}
    </header>
  )
}

export function DialogBody({
  className = '',
  children,
}: {
  className?: string
  children: ReactNode
}) {
  return <div className={`dialog-body ${className}`.trim()}>{children}</div>
}

/** Buttons on the right; `note` sits on the left for context such as a count. */
export function DialogFooter({
  note,
  className = '',
  children,
}: {
  note?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <footer className={`dialog-footer ${className}`.trim()}>
      {note && <span className="dialog-footer-note">{note}</span>}
      {children}
    </footer>
  )
}
