import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useOutletContext, useParams } from 'react-router-dom'
import { ApiError, errorMessage, isAbortError } from '../../api/client'
import {
  getTargetResources,
  offboardApplicationOnboarding,
  scaleApplicationOnboarding,
  syncApplicationOnboarding,
  type ApplicationOnboarding,
} from '../../api/onboarding'
import { DeploymentTargetLogo } from '../../components/DeploymentTargetLogo'
import { Banner } from '../../components/ui/Banner'
import { buttonClass } from '../../components/ui/button-class'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageHeader } from '../../components/ui/PageHeader'
import { RefreshIndicator } from '../../components/ui/RefreshIndicator'
import { Skeleton } from '../../components/ui/Skeleton'
import { Tabs } from '../../components/ui/Tabs'
import { usePolledResource } from '../../hooks/usePolledResource'
import type { AppShellContext } from '../../lib/app-shell'
import { ResourceExplorer } from '../resources/ResourceExplorer'
import {
  endpointLinks,
  getApplicationReleases,
  releaseScope,
  type ApplicationEndpoint,
} from './application-detail'
import { ApplicationTimeline } from './ApplicationTimeline'
import { ChartValuesPanel } from './ChartValuesPanel'
import { DetailHeader, type DetailAction } from './DetailHeader'
import { OffboardDialog } from './OffboardDialog'
import { ScaleDialog } from './ScaleDialog'
import { TargetsPanel } from './TargetsPanel'
import './application-detail.css'

// The diff viewer is heavy and opened rarely, so it is its own chunk.
const ApplicationManifestsModal = lazy(() =>
  import('./ApplicationManifestsModal').then((module) => ({
    default: module.ApplicationManifestsModal,
  })),
)

const pollIntervalMs = 5_000

type Feedback = { tone: 'success' | 'error'; message: string } | null

export function ApplicationDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { setApplicationTopbar } = useOutletContext<AppShellContext>()
  const [action, setAction] = useState<DetailAction>(null)
  const [feedback, setFeedback] = useState<Feedback>(null)
  const [scaling, setScaling] = useState(false)
  const [scaleError, setScaleError] = useState('')
  const [confirmingOffboard, setConfirmingOffboard] = useState(false)
  const [activeTab, setActiveTab] = useState('resources')
  const [resourceTargetId, setResourceTargetId] = useState('')
  const [endpoints, setEndpoints] = useState<ApplicationEndpoint[]>([])
  const [showingManifests, setShowingManifests] = useState(false)

  const load = useCallback((signal: AbortSignal) => getApplicationReleases(id, signal), [id])
  const releasesQuery = usePolledResource(load, { intervalMs: pollIntervalMs })
  const releases = releasesQuery.data ?? []
  const missing = releasesQuery.error instanceof ApiError && releasesQuery.error.status === 404
  const record = releases.find((release) => release.id === id) ?? null

  const { mutate } = releasesQuery
  const replaceRelease = useCallback(
    (next: ApplicationOnboarding) =>
      mutate((current) => current?.map((release) => (release.id === next.id ? next : release))),
    [mutate],
  )

  // The breadcrumb shows the name instead of the ID.
  const recordName = record?.name
  useEffect(() => {
    setApplicationTopbar(recordName ? { name: recordName } : null)
  }, [recordName, setApplicationTopbar])
  useEffect(() => () => setApplicationTopbar(null), [setApplicationTopbar])

  // Endpoints come from the live Services and Ingresses on each target. Keyed
  // on the target set rather than the record, so a poll that changes only a
  // status does not refetch every target's resource tree.
  const recordId = record?.id
  const targetIds = record?.targets.map((target) => target.id).join(',') ?? ''
  useEffect(() => {
    setEndpoints([])
    if (!recordId || !targetIds) return
    const controller = new AbortController()
    void Promise.all(
      targetIds
        .split(',')
        .map((targetId) => getTargetResources(recordId, targetId, controller.signal)),
    )
      .then((resources) => {
        if (!controller.signal.aborted) setEndpoints(endpointLinks(resources.flat()))
      })
      .catch((error) => {
        if (!isAbortError(error)) setEndpoints([])
      })
    return () => controller.abort()
  }, [recordId, targetIds])

  async function deploy() {
    if (!record) return
    setAction('sync')
    setFeedback(null)
    try {
      const next = await syncApplicationOnboarding(record.id)
      replaceRelease(next)
      setFeedback(
        next.targets.some((target) => target.status === 'failed')
          ? {
              tone: 'error',
              message: 'Synchronization could not start for one or more deployment targets.',
            }
          : { tone: 'success', message: 'Synchronization started for every deployment target.' },
      )
    } catch (error) {
      setFeedback({
        tone: 'error',
        message: errorMessage(error, 'Synchronization could not be started.'),
      })
    } finally {
      setAction(null)
    }
  }

  async function scale(replicas: number) {
    if (!record) return
    setAction('scale')
    setScaleError('')
    setFeedback(null)
    try {
      const next = await scaleApplicationOnboarding(record.id, replicas)
      replaceRelease(next)
      setScaling(false)
      setActiveTab('resources')
      setFeedback(
        next.targets.some((target) => target.status === 'failed')
          ? {
              tone: 'error',
              message: `The ${replicas}-pod value was committed, but synchronization failed for one or more clusters.`,
            }
          : {
              tone: 'success',
              message: `Scaling ${releaseScope(next)} to ${replicas} ${replicas === 1 ? 'pod' : 'pods'} through GitOps.`,
            },
      )
    } catch (error) {
      setScaleError(errorMessage(error, 'The application could not be scaled.'))
    } finally {
      setAction(null)
    }
  }

  async function offboard() {
    if (!record) return
    setAction('offboard')
    setFeedback(null)
    try {
      const next = await offboardApplicationOnboarding(record.id)
      setConfirmingOffboard(false)
      if (next.status === 'offboarded') {
        // Nothing is left to operate on here, so the view moves on: to a
        // sibling release if there is one, otherwise back to the list.
        const remaining = releases.filter((release) => release.id !== next.id)
        mutate(() => remaining)
        navigate(remaining.length > 0 ? `/applications/${remaining[0].id}` : '/applications', {
          replace: true,
        })
        return
      }
      replaceRelease(next)
      setFeedback({
        tone: 'error',
        message: 'One or more clusters could not be offboarded. GitHub values were kept.',
      })
    } catch (error) {
      setFeedback({
        tone: 'error',
        message: errorMessage(error, 'Application could not be offboarded.'),
      })
    } finally {
      setAction(null)
    }
  }

  function selectRelease(releaseId: string) {
    setResourceTargetId('')
    setFeedback(null)
    setConfirmingOffboard(false)
    setScaling(false)
    navigate(`/applications/${releaseId}`, { replace: true })
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

  const targets = record.targets
  // Falls back to the first target if the previous choice left this release.
  const resourceTarget = targets.find((target) => target.id === resourceTargetId) ?? targets[0]

  return (
    <section className="page application-detail" aria-labelledby="application-heading">
      <div className="detail-top">
        <DetailHeader
          record={record}
          action={action}
          onManifests={() => setShowingManifests(true)}
          onDeploy={() => void deploy()}
          onScale={() => {
            setScaleError('')
            setScaling(true)
          }}
          onOffboard={() => setConfirmingOffboard(true)}
        />
        <RefreshIndicator
          lastUpdated={releasesQuery.lastUpdated}
          refreshing={releasesQuery.refreshing}
          failed={Boolean(releasesQuery.error)}
        />
      </div>

      {releasesQuery.error && (
        <Banner
          tone="error"
          title="Status refresh failed"
          onRetry={() => void releasesQuery.reload()}
        >
          {releasesQuery.error.message}
        </Banner>
      )}

      {feedback && (
        <Banner
          tone={feedback.tone}
          title={feedback.tone === 'error' ? 'Application action failed' : 'Application updated'}
          onDismiss={() => setFeedback(null)}
        >
          {feedback.message}
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

      <TargetsPanel namespace={record.namespace} targets={targets} endpoints={endpoints} />

      <Tabs
        label="Application details"
        activeId={activeTab}
        onChange={setActiveTab}
        items={[
          {
            id: 'resources',
            label: 'Kubernetes resources',
            content:
              targets.length === 0 ? (
                <div className="panel">
                  <EmptyState
                    title="No deployment targets"
                    description="Onboard this application to a cluster to see its resources."
                  />
                </div>
              ) : (
                <div className="detail-resources">
                  {/* Resources live on one cluster, so targets are inspected one
                      at a time rather than merged. */}
                  {targets.length > 1 && (
                    <div className="target-switch" role="group" aria-label="Choose a cluster">
                      {targets.map((target) => (
                        <button
                          key={target.id}
                          type="button"
                          className={
                            resourceTarget.id === target.id
                              ? 'target-switch-item is-active'
                              : 'target-switch-item'
                          }
                          aria-pressed={resourceTargetId === target.id}
                          onClick={() => setResourceTargetId(target.id)}
                        >
                          <DeploymentTargetLogo target={target} />
                          {target.clusterName}
                        </button>
                      ))}
                    </div>
                  )}
                  <ResourceExplorer
                    key={resourceTarget.id}
                    onboardingId={record.id}
                    target={resourceTarget}
                  />
                </div>
              ),
          },
          { id: 'chart', label: 'Chart & values', content: <ChartValuesPanel record={record} /> },
          { id: 'timeline', label: 'Timeline', content: <ApplicationTimeline record={record} /> },
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

      <ScaleDialog
        key={`scale-${scaling}`}
        record={record}
        open={scaling}
        submitting={action === 'scale'}
        error={scaleError}
        onClose={() => setScaling(false)}
        onSubmit={(replicas) => void scale(replicas)}
        onError={setScaleError}
      />

      <OffboardDialog
        key={`offboard-${confirmingOffboard}`}
        record={record}
        open={confirmingOffboard}
        submitting={action === 'offboard'}
        onClose={() => setConfirmingOffboard(false)}
        onConfirm={() => void offboard()}
      />
    </section>
  )
}
