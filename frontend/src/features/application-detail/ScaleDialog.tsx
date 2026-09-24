import { useState, type FormEvent } from 'react'
import type { ApplicationOnboarding } from '../../api/onboarding'
import { Button } from '../../components/ui/Button'
import { Dialog, DialogDescription, DialogTitle } from '../../components/ui/Dialog'
import { releaseScope } from './application-detail'

type Props = {
  record: ApplicationOnboarding
  open: boolean
  submitting: boolean
  error: string
  onClose: () => void
  onSubmit: (replicas: number) => void
  onError: (message: string) => void
}

export function ScaleDialog({
  record,
  open,
  submitting,
  error,
  onClose,
  onSubmit,
  onError,
}: Props) {
  const [replicas, setReplicas] = useState('')

  function submit(event: FormEvent) {
    event.preventDefault()
    const value = Number(replicas)
    if (!Number.isInteger(value) || value < 1 || value > 1000) {
      onError('Enter a whole number from 1 to 1000.')
      return
    }
    onSubmit(value)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      size="sm"
      dismissible={!submitting}
    >
      <form onSubmit={submit}>
        <header className="dialog-header">
          <div className="dialog-title-group">
            <p className="kicker">GitOps scaling</p>
            <DialogTitle asChild>
              <h3>Scale {record.name} pods</h3>
            </DialogTitle>
          </div>
        </header>
        <div className="dialog-body">
          <DialogDescription asChild>
            <p>
              Set the replica count for <strong>{releaseScope(record)}</strong>. The value is
              committed to GitHub and synchronized to{' '}
              {record.targets.length === 1
                ? record.targets[0].clusterName
                : `${record.targets.length} clusters`}
              .
            </p>
          </DialogDescription>
          <label className="field">
            <span>Number of pods</span>
            <input
              className="input"
              autoFocus
              type="number"
              min="1"
              max="1000"
              step="1"
              inputMode="numeric"
              placeholder="For example, 3"
              value={replicas}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'application-scale-error' : undefined}
              onChange={(event) => {
                setReplicas(event.target.value)
                onError('')
              }}
            />
          </label>
          {error && (
            <p className="field-error" id="application-scale-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="dialog-footer">
          <Button disabled={submitting} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" loading={submitting}>
            {submitting ? 'Scaling…' : 'Scale pods'}
          </Button>
        </footer>
      </form>
    </Dialog>
  )
}
