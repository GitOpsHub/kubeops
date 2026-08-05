import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useOutletContext, useParams } from 'react-router-dom'
import {
  ApiError,
  getApplicationOnboarding,
  getApplicationOnboardings,
  getTargetResources,
  offboardApplicationOnboarding,
  scaleApplicationOnboarding,
  syncApplicationOnboarding,
  type ApplicationOnboarding,
  type ApplicationDeployment,
  type ResourceNode,
} from '../api/onboarding'
import type { ApplicationEndpoint, AppShellContext } from '../lib/app-shell'
import { ApplicationManifestsModal } from './ApplicationManifestsModal'
import { ApplicationTimeline } from './ApplicationTimeline'
import { ProviderLogo } from './BrandIcons'
import { DeploymentTargetLogo } from './DeploymentTargetPanel'
import { ResourceExplorer } from './ResourceExplorer'
import { StatusBadge } from './StatusBadge'
import { Tabs } from './Tabs'
import { Dialog, DialogDescription, DialogTitle } from './ui/Dialog'
import { Menu, MenuItem } from './ui/Menu'

const pollIntervalMs = 5_000

function releaseScope(record: ApplicationOnboarding) {
  return `${record.environment}-${record.region}`
}

function releaseSyncStatus(targets: ApplicationDeployment[]) {
  const statuses = targets.map((target) =>
    target.syncStatus.trim().toLowerCase().replace(/\s+/g, ''),
  )
  if (statuses.length > 0 && statuses.every((status) => status === 'synced')) {
    return 'Synced' as const
  }
  if (statuses.some((status) => status === 'outofsync')) {
    return 'Out of Sync' as const
  }
  return 'Sync pending' as const
}

function endpointLinks(nodes: ResourceNode[]) {
  const endpoints = new Map<string, ApplicationEndpoint>()

  for (const node of nodes) {
    if (!node.exposure) continue
    const ports = (node.exposure.ports ?? [])
      .map((value) => {
        const match = value.match(/^(\d+)\/TCP$/i)
        return match ? Number(match[1]) : 0
      })
      .filter(Boolean)
    const networkPorts = ports.length > 0 ? ports : [443]

    for (const address of node.exposure.addresses) {
      const trimmed = address.trim()
      if (!trimmed || trimmed.includes('/') || trimmed.includes('@')) continue
      const host = trimmed.includes(':') && !trimmed.startsWith('[') ? `[${trimmed}]` : trimmed

      for (const port of networkPorts) {
        const scheme = port === 443 ? 'https' : 'http'
        const portSuffix =
          (scheme === 'https' && port === 443) || (scheme === 'http' && port === 80)
            ? ''
            : `:${port}`
        const url = `${scheme}://${host}${portSuffix}`
        endpoints.set(url, { label: url, url })
      }
    }
  }
  return [...endpoints.values()]
}

function valuesFileLink(record: ApplicationOnboarding) {
  const repositoryUrl = record.valuesRepositoryUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
  if (!repositoryUrl) return null

  const hasRegionValues = record.targets.some(
    (target) => target.hasRegionValues && target.region === record.region,
  )
  const path = hasRegionValues
    ? `${record.environment}/${record.region}/values.yaml`
    : 'values.yaml'
  const revision = record.valuesCommitSha.trim() || record.valuesRevision.trim() || 'HEAD'
  const encodedPath = path.split('/').map(encodeURIComponent).join('/')

  return {
    path,
    revision,
    url: `${repositoryUrl}/blob/${encodeURIComponent(revision)}/${encodedPath}`,
  }
}

async function getApplicationReleases(
  selected: ApplicationOnboarding,
  signal?: AbortSignal,
) {
  const releases: ApplicationOnboarding[] = []
  let page = 1

  while (true) {
    const response = await getApplicationOnboardings(
      { search: selected.name, page, pageSize: 200 },
      signal,
    )
    releases.push(...response.items)
    if (releases.length >= response.total) break
    page += 1
  }

  const normalizedName = selected.name.trim().toLocaleLowerCase()
  const matching = releases.filter(
    (release) => release.name.trim().toLocaleLowerCase() === normalizedName,
  )
  if (!matching.some((release) => release.id === selected.id)) matching.push(selected)

  return matching.sort(
    (left, right) =>
      releaseScope(left).localeCompare(releaseScope(right)) ||
      left.createdAt.localeCompare(right.createdAt),
  )
}

function BackToApplications() {
  return (
    <Link className="detail-back-button" to="/applications">
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M10.5 3.5 6 8l4.5 4.5M6.5 8H14" />
      </svg>
      <span>Back to applications</span>
    </Link>
  )
}

export function ApplicationDetail() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { setApplicationTopbar } = useOutletContext<AppShellContext>()
  const [releases, setReleases] = useState<ApplicationOnboarding[]>([])
  const [selectedReleaseId, setSelectedReleaseId] = useState(id)
  const [loading, setLoading] = useState(true)
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState('')
  const [action, setAction] = useState<'sync' | 'scale' | 'offboard' | null>(null)
  const [actionMessage, setActionMessage] = useState('')
  const [actionError, setActionError] = useState('')
  const [scaling, setScaling] = useState(false)
  const [scaleReplicas, setScaleReplicas] = useState('')
  const [scaleError, setScaleError] = useState('')
  const [confirmingOffboard, setConfirmingOffboard] = useState(false)
  const [offboardConfirmation, setOffboardConfirmation] = useState('')
  const [activeTab, setActiveTab] = useState('resources')
  const [resourceTargetId, setResourceTargetId] = useState('')
  const [endpoints, setEndpoints] = useState<ApplicationEndpoint[]>([])
  const [showingManifests, setShowingManifests] = useState(false)

  const load = useCallback(
    async (signal?: AbortSignal, quiet = false) => {
      if (!quiet) setLoading(true)
      try {
        const selected = await getApplicationOnboarding(id, signal)
        const next = await getApplicationReleases(selected, signal)
        setReleases(next)
        setSelectedReleaseId(id)
        setMissing(false)
        setError('')
      } catch (loadError) {
        if (loadError instanceof DOMException && loadError.name === 'AbortError') return
        if (loadError instanceof ApiError && loadError.status === 404) {
          setMissing(true)
          setReleases([])
          setError('')
          return
        }
        setError(
          loadError instanceof Error ? loadError.message : 'Application could not be loaded',
        )
      } finally {
        if (!quiet) setLoading(false)
      }
    },
    [id],
  )

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    const interval = window.setInterval(() => void load(undefined, true), pollIntervalMs)
    return () => {
      controller.abort()
      window.clearInterval(interval)
    }
  }, [load])

  const record =
    releases.find((release) => release.id === selectedReleaseId) ??
    releases.find((release) => release.id === id) ??
    null
  const valuesFile = record ? valuesFileLink(record) : null

  useEffect(() => {
    setEndpoints([])
  }, [record?.id])

  useEffect(() => {
    if (!record) {
      setEndpoints([])
      setApplicationTopbar(null)
      return
    }

    const controller = new AbortController()
    const baseState = {
      name: record.name,
      syncStatus: releaseSyncStatus(record.targets),
    }
    setApplicationTopbar({ ...baseState, endpoints: [] })

    void Promise.all(
      record.targets.map((target) =>
        getTargetResources(record.id, target.id, controller.signal),
      ),
    )
      .then((resources) => {
        if (!controller.signal.aborted) {
          const nextEndpoints = endpointLinks(resources.flat())
          setEndpoints(nextEndpoints)
          setApplicationTopbar({
            ...baseState,
            endpoints: nextEndpoints,
          })
        }
      })
      .catch((endpointError) => {
        if (!(endpointError instanceof DOMException && endpointError.name === 'AbortError')) {
          setApplicationTopbar({ ...baseState, endpoints: [] })
        }
      })

    return () => {
      controller.abort()
      setApplicationTopbar(null)
    }
  }, [record, setApplicationTopbar])

  async function syncResources() {
    if (!record) return
    setAction('sync')
    setActionMessage('')
    setActionError('')
    try {
      const next = await syncApplicationOnboarding(record.id)
      setReleases((current) =>
        current.map((release) => (release.id === next.id ? next : release)),
      )
      if (next.targets.some((target) => target.status === 'failed')) {
        setActionError('Synchronization could not start for one or more deployment targets.')
      } else {
        setActionMessage('Synchronization started for every deployment target.')
      }
    } catch (syncError) {
      setActionError(
        syncError instanceof Error ? syncError.message : 'Synchronization could not be started.',
      )
    } finally {
      setAction(null)
    }
  }

  async function offboard() {
    if (!record) return
    setAction('offboard')
    setActionMessage('')
    setActionError('')
    try {
      const next = await offboardApplicationOnboarding(record.id)
      setReleases((current) =>
        current.map((release) => (release.id === next.id ? next : release)),
      )
      setConfirmingOffboard(false)
      if (next.status === 'offboarded') {
        const remaining = releases.filter((release) => release.id !== next.id)
        if (remaining.length > 0) {
          setReleases(remaining)
          setSelectedReleaseId(remaining[0].id)
          setResourceTargetId('')
          navigate(`/applications/${remaining[0].id}`, { replace: true })
          return
        }
        navigate('/applications', { replace: true })
        return
      }
      setActionError('One or more clusters could not be offboarded. GitHub values were kept.')
    } catch (offboardError) {
      setActionError(
        offboardError instanceof Error
          ? offboardError.message
          : 'Application could not be offboarded.',
      )
    } finally {
      setAction(null)
    }
  }

  async function scalePods() {
    if (!record) return
    const replicas = Number(scaleReplicas)
    if (!Number.isInteger(replicas) || replicas < 1 || replicas > 1000) {
      setScaleError('Enter a whole number from 1 to 1000.')
      return
    }
    setAction('scale')
    setScaleError('')
    setActionMessage('')
    setActionError('')
    try {
      const next = await scaleApplicationOnboarding(record.id, replicas)
      setReleases((current) =>
        current.map((release) => (release.id === next.id ? next : release)),
      )
      setScaling(false)
      setScaleReplicas('')
      setActiveTab('resources')
      if (next.targets.some((target) => target.status === 'failed')) {
        setActionError(
          `The ${replicas}-pod value was committed, but synchronization failed for one or more clusters.`,
        )
      } else {
        setActionMessage(
          `Scaling ${releaseScope(next)} to ${replicas} ${
            replicas === 1 ? 'pod' : 'pods'
          } through GitOps.`,
        )
      }
    } catch (scaleRequestError) {
      setScaleError(
        scaleRequestError instanceof Error
          ? scaleRequestError.message
          : 'The application could not be scaled.',
      )
    } finally {
      setAction(null)
    }
  }

  if (missing) {
    return (
      <section className="application-detail" aria-labelledby="application-heading">
        <BackToApplications />
        <div className="empty-panel" role="status">
          <strong id="application-heading">Application not found</strong>
          <span>This onboarding no longer exists or the link is incorrect.</span>
        </div>
      </section>
    )
  }

  // Nothing to show yet. The view polls, so a failed attempt is a retry in
  // flight rather than a dead end — it keeps loading and says what went wrong
  // underneath, instead of flipping between a spinner and an error banner.
  if (!record) {
    return (
      <section className="application-detail">
        <BackToApplications />
        <div className="retry-state" role="status">
          <span className="loader" aria-hidden="true" />
          <strong>Loading application…</strong>
          {error && <span>Last attempt failed: {error}</span>}
          {!loading && error && (
            <button type="button" className="text-button" onClick={() => void load()}>
              Try again
            </button>
          )}
        </div>
      </section>
    )
  }

  const visibleTargets = record.targets
  // Falls back to the first target if the previously selected cluster is no
  // longer part of this application.
  const resourceTarget =
    visibleTargets.find((target) => target.id === resourceTargetId) ?? visibleTargets[0]

  return (
    <section className="application-detail" aria-labelledby="application-heading">
      <BackToApplications />

      {error && (
        <div className="error-banner" role="alert">
          <div>
            <strong>Status refresh failed</strong>
            <span>{error}</span>
          </div>
          <button type="button" className="text-button" onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}

      {/* One header instead of three stacked cards: identity and the actions on
          the first row, everything an operator needs to locate the release on
          the second. */}
      <header className="detail-header">
        <div className="detail-headline">
          <div className="detail-identity">
            <ProviderLogo provider="docker" className="detail-image-logo" />
            <div className="detail-identity-copy">
              <p className="kicker">GitOps delivery</p>
              <h1 id="application-heading">{record.name}</h1>
              <strong className="mono detail-image-name" title={record.image}>
                {record.image || 'Image not reported'}
              </strong>
            </div>
          </div>
          <div className="detail-primary-actions" aria-label="Application actions">
            <div
              className="detail-action-state"
              aria-label={`Application sync: ${releaseSyncStatus(record.targets)}`}
            >
              <StatusBadge
                status={releaseSyncStatus(record.targets)}
                tone={
                  releaseSyncStatus(record.targets) === 'Synced'
                    ? 'ok'
                    : releaseSyncStatus(record.targets) === 'Out of Sync'
                      ? 'warn'
                      : 'idle'
                }
              />
            </div>
            <div className="detail-action-buttons">
              <button
                type="button"
                className="ghost-button detail-manifests-button"
                disabled={record.targets.length === 0}
                onClick={() => setShowingManifests(true)}
              >
                <svg viewBox="0 0 18 18" aria-hidden="true">
                  <path d="M5 2.5h6l3 3v10H5zM11 2.5v3h3M7.5 9h4M7.5 12h4" />
                </svg>
                Manifest
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={action !== null || record.targets.length === 0}
                onClick={() => void syncResources()}
              >
                <svg className="detail-deploy-icon" viewBox="0 0 18 18" aria-hidden="true">
                  <path d="M14.5 6A6 6 0 1 0 15 11M14.5 6V2.5M14.5 6H11M9 5.5v7M6.5 10 9 12.5l2.5-2.5" />
                </svg>
                {action === 'sync'
                  ? 'Deploying…'
                  : record.status === 'offboarded'
                    ? 'Deploy again'
                    : 'Deploy'}
              </button>
              <button
                type="button"
                className="ghost-button"
                disabled={
                  action !== null ||
                  record.status === 'offboarded' ||
                  record.targets.length === 0
                }
                onClick={() => {
                  setScaleReplicas('')
                  setScaleError('')
                  setScaling(true)
                }}
              >
                <svg
                  className="scale-horizontal-icon"
                  viewBox="0 0 16 16"
                  aria-hidden="true"
                >
                  <path d="M7 8H2m0 0 3-3M2 8l3 3M9 8h5m0 0-3-3m3 3-3 3" />
                </svg>
                Scale
              </button>
              {/* Argo CD keeps delete out of the primary row too: an
                  irreversible action should not sit one mis-click from Deploy. */}
              <Menu
                className="detail-action-menu"
                trigger={
                  <button
                    type="button"
                    className="ghost-button detail-more-button"
                    aria-label="More application actions"
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <circle cx="3" cy="8" r="1.4" />
                      <circle cx="8" cy="8" r="1.4" />
                      <circle cx="13" cy="8" r="1.4" />
                    </svg>
                  </button>
                }
              >
                <MenuItem
                  className="menu-item menu-item--danger"
                  disabled={
                    action !== null ||
                    record.status === 'offboarded' ||
                    record.targets.length === 0
                  }
                  onSelect={() => {
                    setOffboardConfirmation('')
                    setConfirmingOffboard(true)
                  }}
                >
                  Offboard
                </MenuItem>
              </Menu>
            </div>
          </div>
        </div>

        <div className="detail-context">
          <div className="detail-target-list" aria-label="Deployment clusters">
            {visibleTargets.length === 0 ? (
              <span className="detail-target-empty">No clusters assigned</span>
            ) : (
              visibleTargets.map((target) => (
                <article
                  className="detail-target-chip"
                  key={target.id}
                  aria-label={`Deployment target ${target.clusterName}`}
                >
                  <DeploymentTargetLogo target={target} />
                  <div>
                    <strong>{target.clusterName}</strong>
                    <span>{record.namespace}</span>
                  </div>
                  {target.argoApplicationUrl && (
                    <a
                      className="detail-target-argo-link"
                      href={target.argoApplicationUrl}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Open ${target.clusterName} in Argo CD`}
                      title="Open in Argo CD"
                    >
                      ↗
                    </a>
                  )}
                </article>
              ))
            )}
          </div>

          <section className="detail-endpoints" aria-label="Application URLs">
            <span className="section-label">Endpoints</span>
            {endpoints.length > 0 ? (
              <nav className="detail-endpoint-links" aria-label="Application endpoints">
                {endpoints.map((endpoint) => (
                  <a
                    key={endpoint.url}
                    href={endpoint.url}
                    target="_blank"
                    rel="noreferrer"
                    title={`Open ${endpoint.label}`}
                  >
                    {endpoint.label}
                    <span aria-hidden="true">↗</span>
                  </a>
                ))}
              </nav>
            ) : (
              <span className="detail-endpoint-empty">No external URL reported</span>
            )}
          </section>
        </div>
      </header>

      {showingManifests && (
        <ApplicationManifestsModal
          onboardingId={record.id}
          namespace={record.namespace}
          targets={record.targets}
          onClose={() => setShowingManifests(false)}
        />
      )}

      <Dialog
        open={scaling}
        onOpenChange={(next) => !next && setScaling(false)}
        backdropClassName="confirmation-backdrop"
        className="scale-confirmation application-scale-dialog"
        dismissible={action !== 'scale'}
      >
        {record && (
          <form
            className="application-scale-form"
            onSubmit={(event) => {
              event.preventDefault()
              void scalePods()
            }}
          >
            <div className="application-scale-copy">
              <p className="section-label">GitOps scaling</p>
              <DialogTitle asChild>
                <h3>Scale {record.name} pods</h3>
              </DialogTitle>
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
            </div>
            <label className="application-scale-field">
              <span>Number of pods</span>
              <input
                autoFocus
                type="number"
                min="1"
                max="1000"
                step="1"
                inputMode="numeric"
                placeholder="For example, 3"
                value={scaleReplicas}
                aria-describedby={scaleError ? 'application-scale-error' : undefined}
                onChange={(event) => {
                  setScaleReplicas(event.target.value)
                  setScaleError('')
                }}
              />
            </label>
            {scaleError && (
              <p className="application-scale-error" id="application-scale-error" role="alert">
                {scaleError}
              </p>
            )}
            <div className="confirmation-actions">
              <button
                type="button"
                disabled={action === 'scale'}
                onClick={() => setScaling(false)}
              >
                Cancel
              </button>
              <button
                className="confirm-scale"
                type="submit"
                disabled={action === 'scale'}
              >
                {action === 'scale' ? 'Scaling…' : 'Scale pods'}
              </button>
            </div>
          </form>
        )}
      </Dialog>

      <Dialog
        open={confirmingOffboard}
        onOpenChange={(next) => !next && setConfirmingOffboard(false)}
        backdropClassName="confirmation-backdrop"
        className="offboard-confirmation"
        alert
        // The offboard request is irreversible, so the dialog stays put until it
        // resolves rather than vanishing on a stray Escape mid-flight.
        dismissible={action === null}
      >
        {record && (
          <>
            <header className="offboard-confirmation-header">
              <span className="offboard-confirmation-mark" aria-hidden="true">
                <svg viewBox="0 0 20 20">
                  <path d="M10 7v4M10 13.7v.1M8.6 3.2 2.2 14.3a1.6 1.6 0 0 0 1.4 2.4h12.8a1.6 1.6 0 0 0 1.4-2.4L11.4 3.2a1.6 1.6 0 0 0-2.8 0Z" />
                </svg>
              </span>
              <div>
                <p className="section-label offboard-confirmation-eyebrow">Destructive action</p>
                <DialogTitle asChild>
                  <h3>Offboard {record.name}?</h3>
                </DialogTitle>
              </div>
            </header>

            <DialogDescription asChild>
              <p className="offboard-confirmation-lede">
                Argo CD deletes <strong>{record.name}</strong> and every resource it manages.
                This cannot be undone.
              </p>
            </DialogDescription>

            <section className="offboard-confirmation-scope">
              <p className="section-label">
                Removed from {record.targets.length}{' '}
                {record.targets.length === 1 ? 'cluster' : 'clusters'}
              </p>
              <ul className="offboard-confirmation-targets">
                {record.targets.map((target) => (
                  <li key={target.id}>
                    <DeploymentTargetLogo target={target} />
                    <span>{target.clusterName}</span>
                    <small>{target.region}</small>
                  </li>
                ))}
              </ul>
            </section>

            {/* What survives matters as much as what goes: an operator deciding
                whether to go ahead needs the reassurance stated, not buried in
                the paragraph above. */}
            <p className="offboard-confirmation-kept">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="m3.5 8.5 3 3 6-6.5" />
              </svg>
              The GitHub repository and its values will remain available, so the application can
              be onboarded again.
            </p>

            {/* Typing the name is the same guard Argo CD puts on deleting an
                application: it makes the destructive click deliberate rather
                than muscle memory. */}
            <label className="offboard-confirmation-field">
              <span>
                Type <strong>{record.name}</strong> to confirm
              </span>
              <span
                className={`offboard-confirmation-input ${
                  offboardConfirmation.trim() === record.name ? 'is-armed' : ''
                }`}
              >
                <input
                  autoFocus
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={record.name}
                  value={offboardConfirmation}
                  onChange={(event) => setOffboardConfirmation(event.target.value)}
                />
                {offboardConfirmation.trim() === record.name && (
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="m3.5 8.5 3 3 6-6.5" />
                  </svg>
                )}
              </span>
            </label>

            <div className="confirmation-actions">
              <button
                type="button"
                disabled={action !== null}
                onClick={() => setConfirmingOffboard(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="danger-button offboard-confirmation-submit"
                disabled={action !== null || offboardConfirmation.trim() !== record.name}
                onClick={() => void offboard()}
              >
                {action === 'offboard' ? 'Offboarding…' : 'Offboard application'}
              </button>
            </div>
          </>
        )}
      </Dialog>

      {(actionMessage || actionError) && (
        <div
          className={actionError ? 'error-banner lifecycle-message' : 'success-banner lifecycle-message'}
          role={actionError ? 'alert' : 'status'}
        >
          <div>
            <strong>{actionError ? 'Application action failed' : 'Application updated'}</strong>
            <span>{actionError || actionMessage}</span>
          </div>
        </div>
      )}

      {/* One full-width column: the topology needs every pixel, and a 230px
          rail holding two buttons was not paying for itself. */}
      <div className="detail-body">
        <div className="detail-panels">
          {releases.length > 0 && (
            <nav className="region-rail" aria-label="Filter targets by environment and region">
              <span className="section-label">Scope</span>
              {releases.map((release) => {
              const scope = releaseScope(release)
              const isActive = release.id === record.id
              return (
                <button
                  key={release.id}
                  type="button"
                  className={`region-rail-item ${isActive ? 'is-active' : ''}`}
                  aria-current={isActive ? 'true' : undefined}
                  aria-label={`View ${scope} release`}
                  onClick={() => {
                    setSelectedReleaseId(release.id)
                    setResourceTargetId('')
                    setActionMessage('')
                    setActionError('')
                    setConfirmingOffboard(false)
                    setOffboardConfirmation('')
                    setScaling(false)
                    navigate(`/applications/${release.id}`, { replace: true })
                  }}
                >
                  {scope}
                  <small>{release.targets.length}</small>
                </button>
                )
              })}
            </nav>
          )}

          <Tabs
            label="Application details"
            activeId={activeTab}
            onChange={setActiveTab}
            items={[
              {
                id: 'resources',
                label: 'Kubernetes resources',
                content:
                  visibleTargets.length === 0 ? (
                    <div className="empty-panel">
                      <strong>No deployment targets</strong>
                      <span>Onboard this application to a cluster to see its resources.</span>
                    </div>
                  ) : (
                    <>
                      {/* Resources live on a cluster, so one target is inspected at a
                          time rather than merging objects from several clusters. */}
                      {visibleTargets.length > 1 && (
                        <div className="target-switch" role="group" aria-label="Choose a cluster">
                          {visibleTargets.map((target) => (
                            <button
                              key={target.id}
                              type="button"
                              className={`target-switch-item ${
                                resourceTargetId === target.id ? 'is-active' : ''
                              }`}
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
                    </>
                  ),
              },
              {
                id: 'chart',
                label: 'Chart & values',
                content: (
                  <dl className="fact-list">
                    <div>
                      <dt>Chart</dt>
                      <dd className="mono">
                        {record.chartName} {record.chartRevision}
                      </dd>
                    </div>
                    <div>
                      <dt>Chart repository</dt>
                      <dd className="mono">{record.chartRepoUrl}</dd>
                    </div>
                    <div>
                      <dt>Values file</dt>
                      <dd>
                        {valuesFile ? (
                          <a
                            href={valuesFile.url}
                            target="_blank"
                            rel="noreferrer"
                            title={`Open ${valuesFile.path} at ${valuesFile.revision}`}
                          >
                            {record.valuesRepositoryName}/{valuesFile.path} ↗
                          </a>
                        ) : (
                          '—'
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>Values revision</dt>
                      <dd className="mono">{record.valuesRevision || '—'}</dd>
                    </div>
                    <div>
                      <dt>Values commit</dt>
                      <dd className="mono">{record.valuesCommitSha || '—'}</dd>
                    </div>
                    <div>
                      <dt>Values digest</dt>
                      <dd className="mono">{record.valuesDigest}</dd>
                    </div>
                  </dl>
                ),
              },
              {
                id: 'timeline',
                label: 'Timeline',
                content: <ApplicationTimeline record={record} />,
              },
            ]}
          />
        </div>
      </div>
    </section>
  )
}
