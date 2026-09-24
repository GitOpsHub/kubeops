import { useId, useState, type ReactNode } from 'react'
import { WarningIcon } from '../icons'
import { Button } from './Button'
import { Dialog, DialogDescription } from './Dialog'
import { DialogBody, DialogFooter, DialogHeader } from './DialogParts'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  kicker?: ReactNode
  /** The consequence, in a sentence. Becomes the accessible description. */
  description: ReactNode
  /** Anything else the decision needs: scope lists, warnings. */
  children?: ReactNode
  confirmLabel: string
  /** Shown on the confirm button while `submitting`. */
  submittingLabel?: string
  cancelLabel?: string
  onConfirm: () => void
  submitting?: boolean
  /**
   * Destructive: announces as an alertdialog, draws the confirm button in
   * danger red, and marks the header with a warning glyph.
   */
  danger?: boolean
  /**
   * Arms the confirm button only once this exact text is typed — the guard
   * Argo CD puts on deleting an application.
   */
  typeToConfirm?: string
  /** A form-level error from the last attempt, shown above the buttons. */
  error?: ReactNode
  size?: 'sm' | 'md'
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  kicker,
  description,
  children,
  confirmLabel,
  submittingLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  submitting = false,
  danger = false,
  typeToConfirm,
  error,
  size = 'sm',
}: Props) {
  const [typed, setTyped] = useState('')
  const inputId = useId()
  const armed = !typeToConfirm || typed.trim() === typeToConfirm

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setTyped('')
        onOpenChange(next)
      }}
      size={size}
      alert={danger}
      // The dialog stays put until the request resolves.
      dismissible={!submitting}
    >
      <DialogHeader
        title={title}
        kicker={kicker}
        icon={danger ? <WarningIcon /> : undefined}
        className={danger ? 'dialog-header--danger' : undefined}
      />
      <DialogBody>
        <DialogDescription asChild>
          <p>{description}</p>
        </DialogDescription>
        {children}
        {typeToConfirm && (
          <div className="field">
            <label htmlFor={inputId}>
              Type <strong>{typeToConfirm}</strong> to confirm
            </label>
            <input
              id={inputId}
              className={armed ? 'input confirm-input is-armed' : 'input confirm-input'}
              autoFocus
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder={typeToConfirm}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
          </div>
        )}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button disabled={submitting} onClick={() => onOpenChange(false)}>
          {cancelLabel}
        </Button>
        <Button
          variant={danger ? 'danger' : 'primary'}
          disabled={!armed}
          loading={submitting}
          onClick={onConfirm}
        >
          {submitting && submittingLabel ? submittingLabel : confirmLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
