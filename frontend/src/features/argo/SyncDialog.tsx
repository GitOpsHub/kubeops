import { useId, useState } from 'react'
import { defaultSyncOptions, type ArgoAppStatus, type SyncOptions } from '../../api/argo'
import type { ApplicationOnboarding } from '../../api/onboarding'
import { DeploymentTargetLogo } from '../../components/DeploymentTargetLogo'
import { SyncIcon, WarningIcon } from '../../components/icons'
import { StatusBadge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'
import { DialogBody, DialogFooter, DialogHeader } from '../../components/ui/DialogParts'
import { Checkbox } from '../../components/ui/Field'
import { describeSync } from './sync-summary'
import './argo.css'

type Props = {
  record: ApplicationOnboarding
  statuses: Record<string, ArgoAppStatus | undefined>
  /** Targets ticked when the dialog opens; every target when omitted. */
  initialTargetIds?: string[]
  submitting: boolean
  onClose: () => void
  onSubmit: (options: SyncOptions) => void
}

/**
 * The options Argo CD's own sync panel offers, minus the ones that do not
 * apply to a generated app. Mount it only while open: its state is the
 * request being composed, and a fresh mount starts from the defaults.
 */
export function SyncDialog({
  record,
  statuses,
  initialTargetIds,
  submitting,
  onClose,
  onSubmit,
}: Props) {
  const [selected, setSelected] = useState<string[]>(
    initialTargetIds?.length ? initialTargetIds : record.targets.map((target) => target.id),
  )
  const [options, setOptions] = useState(defaultSyncOptions)
  const summaryId = useId()

  const set = (key: keyof typeof defaultSyncOptions) => (checked: boolean) =>
    setOptions((current) => ({ ...current, [key]: checked }))
  const toggleTarget = (id: string, checked: boolean) =>
    setSelected((current) =>
      checked ? [...current, id] : current.filter((targetId) => targetId !== id),
    )

  const chosen = record.targets.filter((target) => selected.includes(target.id))
  const everyTarget = chosen.length === record.targets.length
  const summary = describeSync(
    options,
    chosen.map((target) => target.clusterName),
    record.valuesRevision,
  )

  function submit() {
    if (chosen.length === 0) return
    // All targets is the server default; sending none keeps that request
    // identical to a plain Deploy.
    onSubmit({ ...options, targetIds: everyTarget ? [] : chosen.map((target) => target.id) })
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      size="md"
      dismissible={!submitting}
      className="sync-dialog"
    >
      <DialogHeader
        title={`Sync ${record.name}`}
        kicker={`${record.environment} · ${record.region}`}
        description="Apply what is in Git to the clusters you choose, the way Argo CD's sync does."
        icon={<SyncIcon />}
        closeLabel="Close"
      />
      <DialogBody className="sync-dialog-body">
        <fieldset className="sync-fieldset">
          <legend>Clusters</legend>
          {record.targets.length > 1 && (
            <div className="sync-fieldset-actions">
              <button
                type="button"
                className="link-button"
                onClick={() =>
                  setSelected(everyTarget ? [] : record.targets.map((target) => target.id))
                }
              >
                {everyTarget ? 'Clear all' : 'Select all'}
              </button>
            </div>
          )}
          <ul className="sync-targets">
            {record.targets.map((target) => {
              const status = statuses[target.id]
              return (
                <li key={target.id}>
                  <Checkbox
                    className="sync-target"
                    checked={selected.includes(target.id)}
                    onChange={(event) => toggleTarget(target.id, event.target.checked)}
                    label={
                      <span className="sync-target-name">
                        <DeploymentTargetLogo target={target} />
                        {target.clusterName}
                      </span>
                    }
                    description={
                      <span className="sync-target-state">
                        <span className="mono">{target.region}</span>
                        <StatusBadge
                          domain="sync"
                          status={status?.sync.status || target.syncStatus || 'Unknown'}
                        />
                        <StatusBadge
                          domain="health"
                          status={status?.health.status || target.healthStatus || 'Unknown'}
                        />
                      </span>
                    }
                  />
                </li>
              )
            })}
          </ul>
        </fieldset>

        <fieldset className="sync-fieldset">
          <legend>Options</legend>
          <Checkbox
            checked={options.prune}
            onChange={(event) => set('prune')(event.target.checked)}
            label="Prune"
            description="Delete resources that are no longer in Git. Turning this off does not override the application's automated sync policy, which still prunes."
          />
          <Checkbox
            checked={options.dryRun}
            onChange={(event) => set('dryRun')(event.target.checked)}
            label="Dry run"
            description="Preview only. Argo CD reports what would change in the Sync tab, and nothing is applied."
          />
          <Checkbox
            checked={options.applyOutOfSyncOnly}
            onChange={(event) => set('applyOutOfSyncOnly')(event.target.checked)}
            label="Apply out-of-sync only"
            description="Skip resources that already match Git. Faster for large applications."
          />
          <Checkbox
            checked={options.force}
            onChange={(event) => set('force')(event.target.checked)}
            label="Force"
            description="Delete and recreate resources that cannot be patched."
          />
          {options.force && (
            <p className="sync-danger" role="note">
              <WarningIcon aria-hidden="true" />
              Force replaces objects outright. Workloads can restart and briefly go unavailable, and
              anything not in Git on those objects is lost.
            </p>
          )}
        </fieldset>

        <p className="sync-summary" id={summaryId} aria-live="polite">
          {summary}
        </p>
      </DialogBody>
      <DialogFooter
        note={`${chosen.length} of ${record.targets.length} ${record.targets.length === 1 ? 'cluster' : 'clusters'}`}
      >
        <Button disabled={submitting} onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          icon={<SyncIcon />}
          loading={submitting}
          disabled={chosen.length === 0}
          aria-describedby={summaryId}
          onClick={submit}
        >
          {options.dryRun ? 'Start dry run' : 'Start sync'}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
