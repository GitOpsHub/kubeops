import { lazy, Suspense, useCallback, useMemo, useState, type ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import type { ArgoOperation, EventFilter, SyncOptions } from '../../api/argo'
import { getOnboardingDefaults } from '../../api/onboarding'
import { Banner } from '../../components/ui/Banner'
import { buttonClass } from '../../components/ui/button-class'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageHeader } from '../../components/ui/PageHeader'
import { RefreshIndicator } from '../../components/ui/RefreshIndicator'
import { Skeleton } from '../../components/ui/Skeleton'
import { Tabs } from '../../components/ui/Tabs'
import { useToast } from '../../components/ui/toast-context'
import { usePolledResource } from '../../hooks/usePolledResource'
import { EventsFeed } from '../argo/EventsFeed'
import { OperationBar } from '../argo/OperationBar'
import { OperationPanel } from '../argo/OperationPanel'
import { isInFlightPhase, operationOutcome } from '../argo/operation-phases'
import { RevisionHistory } from '../argo/RevisionHistory'
import { SyncDialog } from '../argo/SyncDialog'
import { useTargetStatuses } from '../argo/useTargetStatus'
import { ResourceExplorer } from '../resources/ResourceExplorer'
import { releaseScope } from './application-detail'
import { ApplicationTimeline } from './ApplicationTimeline'
import { ChartValuesPanel } from './ChartValuesPanel'
import { DetailHeader } from './DetailHeader'
import { isDetailTab, type DetailTab } from './detail-links'
import { LogsTab } from './LogsTab'
import { OffboardDialog } from './OffboardDialog'
import { ScaleDialog } from './ScaleDialog'
import { TargetSelector } from './TargetSelector'
import { TargetsPanel } from './TargetsPanel'
import { useApplicationDetail } from './useApplicationDetail'
import './application-detail.css'

// The diff viewer is heavy and opened rarely, so it is its own chunk.
const ApplicationManifestsModal = lazy(() =>
  import('./ApplicationManifestsModal').then((module) => ({
    default: module.ApplicationManifestsModal,
  })),
)

// Query keys that narrow the Events tab to one object.
const eventScopeKeys = ['uid', 'kind', 'name', 'namespace'] as const

export function ApplicationDetailPage() {
  const { id = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const toast = useToast()
  const detail = useApplicationDetail(id)
  const { record, releases, releasesQuery, missing, action } = detail
  const [showingManifests, setShowingManifests] = useState(false)
  // Undefined while closed; otherwise the targets ticked when it opened.
  const [syncTargets, setSyncTargets] = useState<string[] | undefined | null>(null)

  const loadDefaults = useCallback((signal: AbortSignal) => getOnboardingDefaults(signal), [])
  const defaults = usePolledResource(loadDefaults)
  // An older API has no capabilities block; it had every action, so missing
  // means allowed.
  const consoleMutations = defaults.data?.capabilities?.consoleMutations ?? true

  const tabParam = params.get('tab')
  const activeTab: DetailTab = isDetailTab(tabParam) ? tabParam : 'resources'
  const targets = useMemo(() => record?.targets ?? [], [record])
  const selectedTarget = targets.find((target) => target.id === params.get('target')) ?? targets[0]
  const eventScope: EventFilter = {}
  for (const key of eventScopeKeys) {
    const value = params.get(key)
    if (value) eventScope[key] = value
  }

  const updateParams = useCallback(
    (patch: Record<string, string | null>) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current)
          for (const [key, value] of Object.entries(patch)) {
            if (value) next.set(key, value)
            else next.delete(key)
          }
          return next
        },
        { replace: true },
      )
    },
    [setParams],
  )
  const clearEventScope = Object.fromEntries(eventScopeKeys.map((key) => [key, null]))
  const selectTab = (tab: string) =>
    updateParams({ tab: tab === 'resources' ? null : tab, ...clearEventScope })
  const selectTarget = (targetId: string) => updateParams({ target: targetId, ...clearEventScope })
  const openSync = (targetId: string) =>
    updateParams({ tab: 'sync', target: targetId, ...clearEventScope })

  const reloadReleases = releasesQuery.reload
  const settled = useCallback(
    (targetId: string, operation: ArgoOperation) => {
      const name = targets.find((target) => target.id === targetId)?.clusterName ?? 'a cluster'
      const outcome = operationOutcome(operation)
      if (operation.dryRun) {
        if (outcome === 'succeeded') {
          toast.success(`Dry run finished on ${name}.`, {
            description: 'Open the Sync tab to see what a sync would change.',
          })
        } else {
          toast.error(`Dry run failed on ${name}.`, { description: operation.message })
        }
      } else if (outcome === 'succeeded') {
        toast.success(`Sync succeeded on ${name}.`)
      } else if (outcome === 'terminated') {
        toast.info(`The sync on ${name} was terminated.`)
      } else {
        toast.error(`Sync failed on ${name}.`, { description: operation.message })
      }
      void reloadReleases()
    },
    [targets, toast, reloadReleases],
  )
  const targetIds = useMemo(() => targets.map((target) => target.id), [targets])
  const live = useTargetStatuses(record?.id ?? '', targetIds, { onSettled: settled })

  async function startSync(options: SyncOptions) {
    const started = await detail.sync(options)
    if (started) {
      setSyncTargets(null)
      live.expectOperation()
    }
  }

  async function scale(replicas: number) {
    if (await detail.scale(replicas)) {
      selectTab('resources')
      live.expectOperation()
    }
  }

  function selectRelease(releaseId: string) {
    setSyncTargets(null)
    detail.selectRelease(releaseId)
  }

  const back = { to: '/applications', label: 'Applications' }

  if (missing) {
    return (
      <section className="page" aria-labelledby="application-heading">
        <PageHeader back={back} id="application-heading" title="Application not found" />
        <div className="panel">
          <EmptyState
            title="This onboarding no longer exists"
            description="It may have been removed, or the link is incorrect."
            action={
              <Link className={buttonClass('primary', 'sm')} to="/applications">
                Back to applications
              </Link>
            }
          />
        </div>
      </section>
    )
  }

  // Nothing to show yet. The view polls, so a failed attempt is a retry in
  // flight rather than a dead end: it keeps loading and says what went wrong.
  if (!record) {
    return (
      <section className="page">
        <div className="detail-loading" role="status">
          <div className="detail-loading-copy">
            {!releasesQuery.error && <span className="spinner" aria-hidden="true" />}
            <strong>Loading application…</strong>
            {releasesQuery.error && <span>Last attempt failed: {releasesQuery.error.message}</span>}
            {!releasesQuery.loading && releasesQuery.error && (
              <button
                type="button"
                className="link-button"
                onClick={() => void releasesQuery.reload()}
              >
                Try again
              </button>
            )}
          </div>
          <Skeleton height={72} radius="var(--radius-lg)" />
          <Skeleton height={320} radius="var(--radius-lg)" />
        </div>
      </section>
    )
  }

  const noTargets = (
    <div className="panel">
      <EmptyState
        title="No deployment targets"
        description="Onboard this application to a cluster to see its resources."
      />
    </div>
  )

  // Per-cluster tabs share one selector, so the cluster being looked at stays
  // put while moving between resources, sync, logs, and events.
  const perTarget = (content: (target: NonNullable<typeof selectedTarget>) => ReactNode) =>
    selectedTarget ? (
      <div className="detail-target-tab">
        {targets.length > 1 && (
          <TargetSelector
            targets={targets}
            statuses={live.statuses}
            value={selectedTarget.id}
            onChange={selectTarget}
          />
        )}
        {content(selectedTarget)}
      </div>
    ) : (
      noTargets
    )

  const selectedStatus = selectedTarget ? live.statuses[selectedTarget.id] : undefined

  return (
    <section className="page application-detail" aria-labelledby="application-heading">
      <div className="detail-top">
        <DetailHeader
          record={record}
          action={action}
          onManifests={() => setShowingManifests(true)}
          onDeploy={() => setSyncTargets(undefined)}
          onScale={() => {
            detail.setScaleError('')
            detail.setScaling(true)
          }}
          onOffboard={() => detail.setConfirmingOffboard(true)}
        />
        <RefreshIndicator
          lastUpdated={releasesQuery.lastUpdated}
          refreshing={releasesQuery.refreshing}
          failed={Boolean(releasesQuery.error)}
        />
      </div>

      <OperationBar targets={targets} statuses={live.statuses} onOpen={openSync} />

      {releasesQuery.error && (
        <Banner
          tone="error"
          title="Status refresh failed"
          onRetry={() => void releasesQuery.reload()}
        >
          {releasesQuery.error.message}
        </Banner>
      )}

      {releases.length > 0 && (
        <nav className="release-rail" aria-label="Filter targets by environment and region">
          <span className="kicker">Release</span>
          <div className="release-rail-options">
            {releases.map((release) => {
              const scope = releaseScope(release)
              const active = release.id === record.id
              return (
                <button
                  key={release.id}
                  type="button"
                  className={active ? 'release-option is-active' : 'release-option'}
                  aria-current={active ? 'true' : undefined}
                  aria-label={`View ${scope} release`}
                  onClick={() => selectRelease(release.id)}
                >
                  {scope}
                  <small>{release.targets.length}</small>
                </button>
              )
            })}
          </div>
        </nav>
      )}

      <TargetsPanel
        onboardingId={record.id}
        namespace={record.namespace}
        targets={targets}
        endpoints={detail.endpoints}
        statuses={live.statuses}
        onOpenSync={openSync}
      />

      <Tabs
        label="Application details"
        activeId={activeTab}
        onChange={selectTab}
        items={[
          {
            id: 'resources',
            label: 'Kubernetes resources',
            content: perTarget((target) => (
              // Resources live on one cluster, so targets are inspected one at
              // a time rather than merged. Edges flow while that cluster syncs.
              <ResourceExplorer
                key={target.id}
                onboardingId={record.id}
                target={target}
                operationRunning={isInFlightPhase(selectedStatus?.operation?.phase)}
              />
            )),
          },
          {
            id: 'sync',
            label: 'Sync',
            content: perTarget((target) => (
              <OperationPanel
                key={target.id}
                record={record}
                target={target}
                status={selectedStatus}
                error={live.errors[target.id] ?? live.error}
                onReload={() => void live.reload()}
                consoleMutations={consoleMutations}
                onSync={() => setSyncTargets([target.id])}
                onRetry={() =>
                  void startSync({
                    targetIds: [target.id],
                    prune: selectedStatus?.operation?.prune ?? true,
                    dryRun: false,
                    force: false,
                    applyOutOfSyncOnly: false,
                  })
                }
                retrying={action === 'sync'}
                onTerminated={live.expectOperation}
              />
            )),
          },
          {
            id: 'logs',
            label: 'Logs',
            content: perTarget((target) => (
              <LogsTab
                key={target.id}
                onboardingId={record.id}
                applicationName={record.name}
                target={target}
              />
            )),
          },
          {
            id: 'events',
            label: 'Events',
            content: perTarget((target) => (
              <EventsFeed
                key={target.id}
                onboardingId={record.id}
                target={target}
                scope={eventScope}
                onClearScope={() => updateParams(clearEventScope)}
              />
            )),
          },
          {
            id: 'history',
            label: 'History',
            content: (
              <RevisionHistory
                record={record}
                statuses={live.statuses}
                consoleMutations={consoleMutations}
                onRolledBack={(next) => {
                  detail.replaceRelease(next)
                  live.expectOperation()
                }}
              />
            ),
          },
          { id: 'chart', label: 'Chart & values', content: <ChartValuesPanel record={record} /> },
          {
            id: 'timeline',
            label: 'Timeline',
            content: <ApplicationTimeline record={record} statuses={live.statuses} />,
          },
        ]}
      />

      {showingManifests && (
        <Suspense fallback={null}>
          <ApplicationManifestsModal
            onboardingId={record.id}
            namespace={record.namespace}
            targets={record.targets}
            onClose={() => setShowingManifests(false)}
          />
        </Suspense>
      )}

      {syncTargets !== null && (
        <SyncDialog
          record={record}
          statuses={live.statuses}
          initialTargetIds={syncTargets}
          submitting={action === 'sync'}
          onClose={() => setSyncTargets(null)}
          onSubmit={(options) => void startSync(options)}
        />
      )}

      <ScaleDialog
        key={`scale-${detail.scaling}`}
        record={record}
        open={detail.scaling}
        submitting={action === 'scale'}
        error={detail.scaleError}
        onClose={() => detail.setScaling(false)}
        onSubmit={(replicas) => void scale(replicas)}
        onError={detail.setScaleError}
      />

      <OffboardDialog
        key={`offboard-${detail.confirmingOffboard}`}
        record={record}
        open={detail.confirmingOffboard}
        submitting={action === 'offboard'}
        onClose={() => detail.setConfirmingOffboard(false)}
        onConfirm={() => void detail.offboard()}
      />
    </section>
  )
}
