import { useState, type FormEvent } from 'react'
import type { ApplicationOnboarding } from '../../api/onboarding'
import { Button } from '../../components/ui/Button'
import { Dialog, DialogDescription } from '../../components/ui/Dialog'
import { DialogBody, DialogFooter, DialogHeader } from '../../components/ui/DialogParts'
import { Field, TextInput } from '../../components/ui/Field'
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
      <form onSubmit={submit} className="dialog-form">
        <DialogHeader kicker="GitOps scaling" title={`Scale ${record.name} pods`} />
        <DialogBody>
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
          <Field label="Number of pods" hint="A whole number from 1 to 1000." error={error}>
            <TextInput
              autoFocus
              type="number"
              min="1"
              max="1000"
              step="1"
              inputMode="numeric"
              placeholder="For example, 3"
              value={replicas}
              onChange={(event) => {
                setReplicas(event.target.value)
                onError('')
              }}
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button disabled={submitting} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" loading={submitting}>
            {submitting ? 'Scaling…' : 'Scale pods'}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  )
}
