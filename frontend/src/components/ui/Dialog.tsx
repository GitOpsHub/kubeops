/**
 * The one dialog primitive.
 *
 * Every modal in this app used to hand-roll its own backdrop, its own Escape
 * listener on `window`, and its own initial focus, which meant each one drifted:
 * three of six never handled Escape, three never dismissed on a backdrop click,
 * none trapped focus, none returned focus to whatever opened them, and none
 * stopped the page behind from scrolling. Nested dialogs were worse — Escape
 * inside the cluster drawer's confirmation closed the whole drawer, because both
 * listeners fired on the same event.
 *
 * Radix supplies exactly that behaviour and nothing visual; Dialog.css carries
 * the look. Parts are exposed rather than wrapped in props: the dialogs here
 * have real markup in their headers, and `asChild` lets that markup stay as it
 * is while Radix owns the semantics.
 */

import * as RadixDialog from '@radix-ui/react-dialog'
import { useEffect, useRef, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import './Dialog.css'

type DialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Extra panel class for dialog-specific layout. */
  className?: string
  /** Panel width: sm for confirmations, xl for code and diff viewers. */
  size?: 'sm' | 'md' | 'lg' | 'xl'
  /** `sheet` slides in from the right edge, `drawer` from the left. */
  variant?: 'center' | 'sheet' | 'drawer'
  /** Destructive confirmations announce as alertdialog. */
  alert?: boolean
  /**
   * Escape and outside-click dismissal. Turn this off while a request is in
   * flight, so the dialog cannot be dismissed out from under its own progress.
   */
  dismissible?: boolean
  /** Set when the dialog has no `DialogDescription`, to silence Radix's warning. */
  describedBy?: string
  children: ReactNode
}

export function Dialog({
  open,
  onOpenChange,
  className = '',
  size = 'md',
  variant = 'center',
  alert = false,
  dismissible = true,
  describedBy,
  children,
}: DialogProps) {
  // Radix fires these for Escape and for pointer-down outside the panel. Both
  // are cancellable, which is how a dialog stays put mid-request.
  const block = dismissible ? undefined : (event: Event) => event.preventDefault()

  /*
   * Radix restores focus to `Dialog.Trigger`, but every dialog here is opened
   * from a button that lives somewhere else entirely — a table row, a toolbar,
   * a row action — so there is no Trigger and `triggerRef` is null, which drops
   * focus onto <body> when the dialog closes. Remembering the element that was
   * focused at open time and restoring it ourselves is what makes closing a
   * dialog return you to where you were.
   */
  const restoreTo = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (open) restoreTo.current = document.activeElement as HTMLElement | null
  }, [open])

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        {/* Content is nested inside Overlay rather than beside it, so the
            backdrop can lay the panel out (centred, or pinned right as a
            sheet) with plain CSS. Outside-click still works: Radix tests
            containment against the Content node, so a click on the Overlay is
            still outside. */}
        <RadixDialog.Overlay className={`dialog-backdrop dialog-backdrop--${variant}`}>
          <RadixDialog.Content
            className={`dialog dialog--${size} dialog--${variant} ${className}`.trim()}
            // Spread, never `role={alert ? 'alertdialog' : undefined}`: Radix sets
            // role="dialog" and then spreads our props over it, so passing an
            // explicit undefined deletes the role instead of leaving the default.
            {...(alert ? { role: 'alertdialog' as const } : {})}
            aria-describedby={describedBy}
            onEscapeKeyDown={block}
            onPointerDownOutside={block}
            onInteractOutside={block}
            onCloseAutoFocus={(event) => {
              const target = restoreTo.current
              if (!target?.isConnected) return
              event.preventDefault()
              target.focus()
            }}
          >
            {children}
          </RadixDialog.Content>
        </RadixDialog.Overlay>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

/**
 * Required by Radix on every dialog. Wrap the heading the design already has
 * with `asChild`; where a dialog has no visible heading, render one with the
 * existing `.sr-only` helper rather than inventing a hidden-text mechanism.
 */
export function DialogTitle(props: ComponentPropsWithoutRef<typeof RadixDialog.Title>) {
  return <RadixDialog.Title {...props} />
}

export function DialogDescription(props: ComponentPropsWithoutRef<typeof RadixDialog.Description>) {
  return <RadixDialog.Description {...props} />
}

/** Closes without threading an onClose callback down through the panel. */
export function DialogClose(props: ComponentPropsWithoutRef<typeof RadixDialog.Close>) {
  return <RadixDialog.Close {...props} />
}
