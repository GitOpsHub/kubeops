import { useMemo, useState } from 'react'
import {
  isLoggableKind,
  terminateTargetOperation,
  type ArgoAppStatus,
  type ArgoOperationResource,
} from '../../api/argo'
import { errorMessage } from '../../api/client'
import type { ApplicationDeployment, ApplicationOnboarding } from '../../api/onboarding'
import { KubernetesResourceIcon } from '../../components/KubernetesResourceIcon'
import { LogsIcon, RetryIcon, SyncIcon, WarningIcon } from '../../components/icons'
import { StatusBadge, Tag } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { DataTable, type Column } from '../../components/ui/DataTable'
import { EmptyState } from '../../components/ui/EmptyState'
import { ErrorState } from '../../components/ui/ErrorState'
import { Switch } from '../../components/ui/Field'
import { LoadingState } from '../../components/ui/LoadingState'
import { Timestamp } from '../../components/ui/Timestamp'
import { useToast } from '../../components/ui/toast-context'
import { LogsSheet } from '../log-viewer/LogsSheet'
import { ElapsedTime } from './ElapsedTime'
import { valuesCommitUrl } from './links'
import {
  deriveOperationSteps,
  initiatorLabel,
  isFailedResource,
  isInFlightPhase,
  operationOutcome,
  resourceResultMeta,
  shortSha,
  valuesRevisionOf,
} from './operation-phases'
import { PhaseStepper } from './PhaseStepper'
import './argo.css'

type Props = {
  record: ApplicationOnboarding
  target: ApplicationDeployment
  status: ArgoAppStatus | undefined
  error: Error | null
  onReload: () => void
  /** Terminate and rollback are hidden when the server turns mutations off. */
  consoleMutations: boolean
  /** Opens the sync dialog with this target ticked. */
  onSync: () => void
  /** Re-runs the failed sync on this target only. */
  onRetry: () => void
  retrying: boolean
  /** A terminate was accepted; the status should be polled closely. */
  onTerminated: () => void
}

function resourceKey(resource: ArgoOperationResource) {
  return [resource.group, resource.kind, resource.namespace, resource.name, resource.hookType]
    .filter(Boolean)
    .join('/')
}

/**
 * The last (or current) Argo CD sync on one cluster: where it is, what it did
 * to each resource, and the controls that act on it.
 */
export function OperationPanel({
  record,
  target,
  status,
  error,
  onReload,
  consoleMutations,
  onSync,
  onRetry,
  retrying,
  onTerminated,
}: Props) {
  const toast = useToast()
  const [failedOnly, setFailedOnly] = useState(false)
  const [confirmingTerminate, setConfirmingTerminate] = useState(false)
  const [terminating, setTerminating] = useState(false)
  const [logResource, setLogResource] = useState<ArgoOperationResource | null>(null)

  const operation = status?.operation ?? null
  const steps = useMemo(() => (operation ? deriveOperationSteps(operation) : []), [operation])

  async function terminate() {
    setTerminating(true)
    try {
      await terminateTargetOperation(record.id, target.id)
      setConfirmingTerminate(false)
      toast.info(`Terminating the sync on ${target.clusterName}.`)
      onTerminated()
    } catch (reason) {
      setConfirmingTerminate(false)
      toast.error(errorMessage(reason, 'The sync could not be terminated.'))
      onReload()
    } finally {
      setTerminating(false)
    }
  }

  if (!status) {
    if (error) {
      return (
        <ErrorState
          title={`Argo CD state for ${target.clusterName} could not be loaded`}
          message={error.message}
          onRetry={onReload}
        />
      )
    }
    return <LoadingState label="Loading sync status…" shape="rows" rows={4} />
  }

  const conditions = status.conditions
  const images = status.images
  const facts = (
    <div className="op-facts">
      {conditions.length > 0 && (
        <section className="op-card" aria-labelledby={`conditions-${target.id}`}>
          <h3 id={`conditions-${target.id}`} className="op-card-title">
            Conditions
          </h3>
          <ul className="op-conditions">
            {conditions.map((condition, index) => (
              <li key={`${condition.type}-${index}`} data-tone="warn">
                <WarningIcon aria-hidden="true" />
                <div>
                  <strong>{condition.type}</strong>
                  <p>{condition.message}</p>
                </div>
                {condition.lastTransitionTime && (
                  <Timestamp value={condition.lastTransitionTime} className="subtle" />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {images.length > 0 && (
        <section className="op-card" aria-labelledby={`images-${target.id}`}>
          <h3 id={`images-${target.id}`} className="op-card-title">
            Images
          </h3>
          <ul className="op-images">
            {images.map((image) => (
              <li key={image} className="mono" title={image}>
                {image}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )

  if (!operation) {
    return (
      <div className="op-panel">
        <div className="op-card">
          <EmptyState
            compact
            icon={<SyncIcon />}
            title={`No sync has run on ${target.clusterName} yet`}
            description="Argo CD keeps the last operation per application. Start one to watch it here, phase by phase."
            action={
              <Button size="sm" variant="primary" icon={<SyncIcon />} onClick={onSync}>
                Sync {target.clusterName}
              </Button>
            }
          />
        </div>
        {facts}
      </div>
    )
  }

  const outcome = operationOutcome(operation)
  const running = isInFlightPhase(operation.phase)
  const valuesSha = valuesRevisionOf(operation.revisions)
  const commitUrl = valuesCommitUrl(record.valuesRepositoryUrl, valuesSha)
  const failures = operation.resources.filter(isFailedResource)
  const rows = failedOnly ? failures : operation.resources
  const canRetry = (outcome === 'failed' || outcome === 'terminated') && !operation.dryRun

  const columns: Column<ArgoOperationResource>[] = [
    {
      id: 'kind',
      header: 'Kind',
      cell: (row) => (
        <span className="op-kind">
          <KubernetesResourceIcon kind={row.kind} />
          {row.kind}
        </span>
      ),
    },
    {
      id: 'name',
      header: 'Name',
      cell: (row) => <span className="mono op-name">{row.name}</span>,
    },
    {
      id: 'namespace',
      header: 'Namespace',
      cell: (row) => <span className="mono subtle">{row.namespace || '—'}</span>,
    },
    {
      id: 'status',
      header: 'Result',
      cell: (row) => {
        const meta = resourceResultMeta(row)
        return (
          <StatusBadge
            domain="operation"
            status={row.hookPhase || row.status}
            tone={meta.tone}
            label={meta.label}
          />
        )
      },
    },
    {
      id: 'hook',
      header: 'Hook',
      cell: (row) =>
        row.hookType ? (
          <span className="op-hook">{row.hookType}</span>
        ) : (
          <span className="subtle">{row.syncPhase || '—'}</span>
        ),
    },
    {
      id: 'message',
      header: 'Message',
      className: 'op-message-cell',
      cell: (row) => <span className="op-message">{row.message || ''}</span>,
    },
    {
      id: 'actions',
      // Visible-to-assistive-tech text: axe does not count aria-label on a th.
      header: <span className="sr-only">Actions</span>,
      align: 'end',
      cell: (row) =>
        isLoggableKind(row.kind) ? (
          <Button
            size="sm"
            variant="ghost"
            icon={<LogsIcon />}
            aria-label={`View logs for ${row.kind} ${row.name}`}
            onClick={() => setLogResource(row)}
          >
            Logs
          </Button>
        ) : null,
    },
  ]

  return (
    <div className="op-panel">
      <section
        className="op-card op-summary"
        data-tone={statusToneFor(outcome)}
        aria-labelledby={`operation-${target.id}`}
      >
        <header className="op-summary-head">
          <div className="op-summary-title">
            <h3 id={`operation-${target.id}`}>
              {operation.dryRun ? 'Dry run' : 'Sync operation'} on {target.clusterName}
            </h3>
            <StatusBadge
              domain="operation"
              status={operation.phase}
              label={outcome === 'terminated' ? 'Terminated' : undefined}
              tone={outcome === 'terminated' ? 'warn' : undefined}
            />
            {operation.dryRun && <Tag>Dry run</Tag>}
            <Tag>{operation.prune ? 'Prune' : 'No prune'}</Tag>
            {operation.retryCount > 0 && <Tag>Retry {operation.retryCount}</Tag>}
          </div>
          <div className="op-summary-actions">
            {running && consoleMutations && outcome !== 'terminating' && (
              <Button size="sm" variant="danger" onClick={() => setConfirmingTerminate(true)}>
                Terminate
              </Button>
            )}
            {canRetry && (
              <Button
                size="sm"
                variant="primary"
                icon={<RetryIcon />}
                loading={retrying}
                onClick={onRetry}
              >
                Retry
              </Button>
            )}
            {!running && (
              <Button size="sm" icon={<SyncIcon />} onClick={onSync}>
                Sync…
              </Button>
            )}
          </div>
        </header>

        <dl className="op-meta">
          <div>
            <dt>{running ? 'Elapsed' : 'Duration'}</dt>
            <dd>
              <ElapsedTime
                startedAt={operation.startedAt}
                finishedAt={operation.finishedAt}
                running={running}
              />
            </dd>
          </div>
          <div>
            <dt>Started</dt>
            <dd>
              <Timestamp value={operation.startedAt} fallback="—" />
            </dd>
          </div>
          <div>
            <dt>Initiated by</dt>
            <dd>{initiatorLabel(operation.initiatedBy)}</dd>
          </div>
          <div>
            <dt>Values revision</dt>
            <dd className="mono">
              {commitUrl ? (
                <a href={commitUrl} target="_blank" rel="noreferrer" title={valuesSha}>
                  {shortSha(valuesSha)} ↗
                </a>
              ) : (
                valuesSha || '—'
              )}
            </dd>
          </div>
        </dl>

        <PhaseStepper steps={steps} />

        {operation.message && (
          <p className="op-message-line" data-tone={statusToneFor(outcome)}>
            {operation.message}
          </p>
        )}
      </section>

      <section className="op-card op-results" aria-labelledby={`results-${target.id}`}>
        <header className="op-results-head">
          <h3 id={`results-${target.id}`} className="op-card-title">
            Resources <span className="subtle tabular">{operation.resources.length}</span>
          </h3>
          <Switch
            label="Failed only"
            checked={failedOnly}
            disabled={failures.length === 0 && !failedOnly}
            onChange={(event) => setFailedOnly(event.target.checked)}
          />
        </header>
        {rows.length > 0 ? (
          <DataTable
            label={`Sync results on ${target.clusterName}`}
            columns={columns}
            rows={rows}
            rowKey={resourceKey}
            rowClassName={(row) => (isFailedResource(row) ? 'is-failed' : '')}
          />
        ) : (
          <EmptyState
            compact
            title={failedOnly ? 'No failed resources' : 'No resources reported yet'}
            description={
              failedOnly
                ? 'Every resource in this operation applied cleanly.'
                : 'Argo CD lists resources as it applies them.'
            }
          />
        )}
      </section>

      {facts}

      <ConfirmDialog
        open={confirmingTerminate}
        onOpenChange={setConfirmingTerminate}
        danger
        title={`Terminate the sync on ${target.clusterName}?`}
        description="Argo CD stops applying resources and marks the operation failed. Anything already applied stays applied, and a running hook Job is not rolled back."
        confirmLabel="Terminate sync"
        submittingLabel="Terminating…"
        submitting={terminating}
        onConfirm={() => void terminate()}
      />

      {logResource && (
        <LogsSheet
          onboardingId={record.id}
          targetId={target.id}
          clusterName={target.clusterName}
          resource={{
            kind: logResource.kind,
            name: logResource.name,
            namespace: logResource.namespace,
          }}
          onClose={() => setLogResource(null)}
        />
      )}
    </div>
  )
}

function statusToneFor(outcome: ReturnType<typeof operationOutcome>) {
  switch (outcome) {
    case 'succeeded':
      return 'ok'
    case 'failed':
      return 'err'
    case 'terminated':
    case 'terminating':
      return 'warn'
    default:
      return 'info'
  }
}
