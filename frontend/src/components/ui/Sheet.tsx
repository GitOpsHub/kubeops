import type { ReactNode } from 'react'
import { Dialog } from './Dialog'
import { DialogHeader } from './DialogParts'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  kicker?: ReactNode
  description?: ReactNode
  /** Controls beside the close button. */
  actions?: ReactNode
  /** Width of the panel: sm 400, md 560, lg 720, xl 960, full the viewport. */
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full'
  closeLabel?: string
  className?: string
  /** Replaces the default header entirely, for sheets with richer identity. */
  header?: ReactNode
  children: ReactNode
}

/**
 * A panel that slides in from the right edge over the page, for detail that
 * should keep the list it came from in view: cluster details, logs, a
 * resource. Built on `Dialog`, so focus, Escape, and stacking behave the same.
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  kicker,
  description,
  actions,
  size = 'md',
  closeLabel = 'Close',
  className = '',
  header,
  children,
}: Props) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      variant="sheet"
      size={size}
      className={`sheet sheet--${size} ${className}`.trim()}
      describedBy={description ? undefined : false}
    >
      {header ?? (
        <DialogHeader
          title={title}
          kicker={kicker}
          description={description}
          actions={actions}
          closeLabel={closeLabel}
        />
      )}
      {children}
    </Dialog>
  )
}
