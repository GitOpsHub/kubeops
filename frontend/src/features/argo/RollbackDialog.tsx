import { useState } from 'react'
import { rollbackApplication, type ValuesRevision } from '../../api/argo'
import { errorMessage } from '../../api/client'
import type { ApplicationOnboarding } from '../../api/onboarding'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { useToast } from '../../components/ui/toast-context'
import { shortSha } from './operation-phases'
import { ValuesDiff } from './ValuesDiff'
import './argo.css'

type Props = {
  record: ApplicationOnboarding
  commit: ValuesRevision
  current: ValuesRevision
  path: string
  branch: string
  onClose: () => void
  onRolledBack: (next: ApplicationOnboarding) => void
}

/**
 * A GitOps rollback: the values file as it was at `commit` goes back into Git
 * as a new commit, and Argo CD syncs it like any other change. Argo CD's own
 * rollback is refused for apps with automated sync, and self-heal would undo
 * it anyway — which is why this says exactly what does and does not move.
 */
export function RollbackDialog({
  record,
  commit,
  current,
  path,
  branch,
  onClose,
  onRolledBack,
}: Props) {
  const toast = useToast()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const short = shortSha(commit.sha)
  const clusters = record.targets.map((target) => target.clusterName)
  const production = record.environment.toLowerCase() === 'prod'

  async function confirm() {
    setSubmitting(true)
    setError('')
    try {
      const next = await rollbackApplication(record.id, commit.sha)
      toast.success(
        `Rolled back ${record.environment}-${record.region} values to ${short}. Argo CD is syncing ${clusters.length} ${clusters.length === 1 ? 'cluster' : 'clusters'}.`,
      )
      onRolledBack(next)
      onClose()
    } catch (reason) {
      setError(errorMessage(reason, 'The rollback could not be committed.'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      size="md"
      title={`Roll back ${record.name} to ${short}?`}
      kicker={`${record.environment} · ${record.region}`}
      description={`KubeOps commits ${path} as it was at ${short} to ${branch} as a new commit, then Argo CD syncs it.`}
      confirmLabel="Roll back"
      submittingLabel="Rolling back…"
      submitting={submitting}
      typeToConfirm={production ? record.name : undefined}
      error={error}
      onConfirm={() => void confirm()}
    >
      <ValuesDiff
        onboardingId={record.id}
        fromSha={current.sha}
        toSha={commit.sha}
        fromLabel={`Current (${shortSha(current.sha)})`}
        toLabel={short}
        label={`Values changes from rolling back to ${short}`}
      />
      <ul className="rollback-consequences">
        <li>
          A new commit on <strong className="mono">{branch}</strong> restores{' '}
          <span className="mono">{path}</span>. Nothing is force-pushed; history is kept.
        </li>
        <li>
          Automated sync applies it to {clusters.length}{' '}
          {clusters.length === 1 ? 'cluster' : 'clusters'}: {clusters.join(', ') || 'none'}.
        </li>
        <li>
          Not rolled back: the chart revision ({record.chartName} {record.chartRevision}) and the
          shared root <span className="mono">values.yaml</span>.
        </li>
      </ul>
    </ConfirmDialog>
  )
}
