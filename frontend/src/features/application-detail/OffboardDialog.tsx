import type { ApplicationOnboarding } from '../../api/onboarding'
import { DeploymentTargetLogo } from '../../components/DeploymentTargetLogo'
import { CheckIcon } from '../../components/icons'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
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
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      size="md"
      danger
      kicker="Destructive action"
      title={`Offboard ${record.name}?`}
      description={
        <>
          Argo CD deletes <strong>{record.name}</strong> and every resource it manages. This cannot
          be undone.
        </>
      }
      typeToConfirm={record.name}
      confirmLabel="Offboard application"
      submittingLabel="Offboarding…"
      submitting={submitting}
      onConfirm={onConfirm}
    >
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
        <CheckIcon />
        The GitHub repository and its values will remain available, so the application can be
        onboarded again.
      </p>
    </ConfirmDialog>
  )
}
