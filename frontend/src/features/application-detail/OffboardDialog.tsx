import { useState } from 'react'
import type { ApplicationOnboarding } from '../../api/onboarding'
import { DeploymentTargetLogo } from '../../components/DeploymentTargetLogo'
import { Button } from '../../components/ui/Button'
import { Dialog, DialogDescription, DialogTitle } from '../../components/ui/Dialog'
import { plural } from '../../lib/format'

type Props = {
  record: ApplicationOnboarding
  open: boolean
  submitting: boolean
  onClose: () => void
  onConfirm: () => void
}

/**
 * Ordered the way the decision is made: what is about to happen, exactly
 * where, what survives it, and a typed confirmation — the same guard Argo CD
 * puts on deleting an application — so the destructive click is deliberate.
 */
export function OffboardDialog({ record, open, submitting, onClose, onConfirm }: Props) {
  const [confirmation, setConfirmation] = useState('')
  const armed = confirmation.trim() === record.name

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      size="md"
      alert
      // Irreversible: the dialog stays put until the request resolves.
      dismissible={!submitting}
    >
      <header className="dialog-header offboard-header">
        <span className="offboard-mark" aria-hidden="true">
          <svg viewBox="0 0 20 20">
            <path d="M10 7v4M10 13.7v.1M8.6 3.2 2.2 14.3a1.6 1.6 0 0 0 1.4 2.4h12.8a1.6 1.6 0 0 0 1.4-2.4L11.4 3.2a1.6 1.6 0 0 0-2.8 0Z" />
          </svg>
        </span>
        <div className="dialog-title-group">
          <p className="kicker">Destructive action</p>
          <DialogTitle asChild>
            <h3>Offboard {record.name}?</h3>
          </DialogTitle>
        </div>
      </header>

      <div className="dialog-body">
        <DialogDescription asChild>
          <p>
            Argo CD deletes <strong>{record.name}</strong> and every resource it manages. This
            cannot be undone.
          </p>
        </DialogDescription>

        <section className="offboard-scope">
          <p className="kicker">Removed from {plural(record.targets.length, 'cluster')}</p>
          <ul>
            {record.targets.map((target) => (
              <li key={target.id}>
                <DeploymentTargetLogo target={target} />
                <span>{target.clusterName}</span>
                <small className="mono">{target.region}</small>
              </li>
            ))}
          </ul>
        </section>

        <p className="offboard-kept">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="m3.5 8.5 3 3 6-6.5" />
          </svg>
          The GitHub repository and its values will remain available, so the application can be
          onboarded again.
        </p>

        <label className="field">
          <span>
            Type <strong>{record.name}</strong> to confirm
          </span>
          <input
            className={armed ? 'input offboard-input is-armed' : 'input offboard-input'}
            autoFocus
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder={record.name}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </label>
      </div>

      <footer className="dialog-footer">
        <Button disabled={submitting} onClick={onClose}>
          Cancel
        </Button>
        <Button variant="danger" disabled={!armed} loading={submitting} onClick={onConfirm}>
          {submitting ? 'Offboarding…' : 'Offboard application'}
        </Button>
      </footer>
    </Dialog>
  )
}
