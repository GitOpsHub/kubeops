import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ApiError,
  getApplicationOnboarding,
  getApplicationOnboardings,
  offboardApplicationOnboarding,
  scaleApplicationOnboarding,
  syncApplicationOnboarding,
  type ApplicationOnboarding,
} from '../api/onboarding'
import { KubernetesLogo, ProviderLogo } from './BrandIcons'
import { DeploymentTargetLogo } from './DeploymentTargetPanel'
import { DeployStepper } from './DeployStepper'
import { ResourceExplorer } from './ResourceExplorer'
import { Tabs } from './Tabs'

const pollIntervalMs = 5_000

function releaseScope(record: ApplicationOnboarding) {
  return `${record.environment}-${record.region}`
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

function formatTimestamp(value: string | null) {
  return value ? new Date(value).toLocaleString() : 'Not yet'
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
  const [activeTab, setActiveTab] = useState('resources')
  const [resourceTargetId, setResourceTargetId] = useState('')

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

  if (loading && !record) {
    return (
      <section className="application-detail">
        <div className="table-state" role="status">
          <span className="loader" aria-hidden="true" />
          Loading application…
        </div>
      </section>
    )
  }

  if (!record) {
    return (
      <section className="application-detail">
        <BackToApplications />
        <div className="error-banner" role="alert">
          <div>
            <strong>Application could not be loaded</strong>
            <span>{error}</span>
          </div>
          <button type="button" className="text-button" onClick={() => void load()}>
            Try again
          </button>
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

      <header className="detail-header">
        <div className="detail-identity">
          <div className="detail-identity-copy">
            <p className="kicker">GitOps delivery</p>
            <h1 id="application-heading">{record.name}</h1>
            <div className="detail-image-version">
              <ProviderLogo provider="docker" className="detail-image-logo" />
              <div>
                <span>Container image</span>
                <strong className="mono">{record.image || 'Image not reported'}</strong>
              </div>
            </div>
          </div>
          <div className="detail-primary-actions" aria-label="Application actions">
            <button
              type="button"
              className="primary-button"
              disabled={action !== null || record.targets.length === 0}
              onClick={() => void syncResources()}
            >
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
              Scale
            </button>
          </div>
          <div className="detail-target-summary" aria-label="Deployment clusters">
            <p className="section-label">
              {visibleTargets.length === 1 ? 'Deployment cluster' : 'Deployment clusters'}
            </p>
            <div className="detail-target-list">
              {visibleTargets.length === 0 ? (
                <span className="detail-target-empty">No clusters assigned</span>
              ) : (
                visibleTargets.map((target) => (
                  <article
                    className="detail-target-identity"
                    key={target.id}
                    aria-label={`Deployment target ${target.clusterName}`}
                  >
                    <div className="detail-target-row">
                      <DeploymentTargetLogo target={target} />
                      <div>
                        <span>Cluster</span>
                        <strong>{target.clusterName}</strong>
                      </div>
                    </div>
                    <div className="detail-target-row">
                      <span className="detail-namespace-logo" aria-hidden="true">
                        <KubernetesLogo />
                      </span>
                      <div>
                        <span>Namespace</span>
                        <strong>{record.namespace}</strong>
                      </div>
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
          </div>
        </div>
        <DeployStepper targets={record.targets} />
      </header>

      {scaling && (
        <div className="confirmation-backdrop" role="presentation">
          <form
            className="scale-confirmation application-scale-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="application-scale-title"
            onSubmit={(event) => {
              event.preventDefault()
              void scalePods()
            }}
          >
            <p className="section-label">GitOps scaling</p>
            <h3 id="application-scale-title">Scale {record.name} pods</h3>
            <p>
              Set the replica count for <strong>{releaseScope(record)}</strong>. The value is
              committed to GitHub and synchronized to{' '}
              {record.targets.length === 1
                ? record.targets[0].clusterName
                : `${record.targets.length} clusters`}
              .
            </p>
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
        </div>
      )}

      {confirmingOffboard && (
        <section className="offboard-confirmation" aria-labelledby="offboard-heading">
          <div>
            <strong id="offboard-heading">Remove this application from every cluster?</strong>
            <span>
              Argo CD will delete the application and its managed resources from{' '}
              {record.targets.length} {record.targets.length === 1 ? 'cluster' : 'clusters'}.
              The GitHub repository and its values will remain available.
            </span>
          </div>
          <div>
            <button
              type="button"
              className="text-button"
              disabled={action !== null}
              onClick={() => setConfirmingOffboard(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="danger-button"
              disabled={action !== null}
              onClick={() => void offboard()}
            >
              {action === 'offboard' ? 'Offboarding…' : 'Offboard application'}
            </button>
          </div>
        </section>
      )}

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

      <div className="detail-body">
        {releases.length > 0 && (
          <nav className="region-rail" aria-label="Filter targets by environment and region">
            <p className="section-label">Deployment scope</p>
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

        <div className="detail-panels">
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
                      <dt>Values repository</dt>
                      <dd>
                        {record.valuesRepositoryUrl ? (
                          <a href={record.valuesRepositoryUrl} target="_blank" rel="noreferrer">
                            {record.valuesRepositoryName} ↗
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
                content: (
                  <div className="timeline">
                    <div className="timeline-entry">
                      <span className="timeline-marker" aria-hidden="true" />
                      <div>
                        <strong>Onboarded</strong>
                        <span>{formatTimestamp(record.createdAt)}</span>
                      </div>
                    </div>
                    <div className="timeline-entry">
                      <span className="timeline-marker" aria-hidden="true" />
                      <div>
                        <strong>Last updated</strong>
                        <span>{formatTimestamp(record.updatedAt)}</span>
                      </div>
                    </div>
                    <div className="timeline-entry">
                      <span className="timeline-marker" aria-hidden="true" />
                      <div>
                        <strong>Completed</strong>
                        <span>{formatTimestamp(record.completedAt)}</span>
                      </div>
                    </div>
                    {visibleTargets.map((target) => (
                      <div className="timeline-entry" key={target.id}>
                        <span className="timeline-marker" aria-hidden="true" />
                        <div>
                          <strong>
                            {target.clusterName} · {target.status}
                          </strong>
                          <span>{formatTimestamp(target.updatedAt)}</span>
                        </div>
                      </div>
                    ))}
                    <section className="application-danger-zone">
                      <div>
                        <strong>Offboard application</strong>
                        <span>Remove managed resources while keeping the GitHub values.</span>
                      </div>
                      <button
                        type="button"
                        className="danger-button"
                        disabled={
                          action !== null ||
                          record.status === 'offboarded' ||
                          record.targets.length === 0
                        }
                        onClick={() => setConfirmingOffboard(true)}
                      >
                        Offboard
                      </button>
                    </section>
                  </div>
                ),
              },
            ]}
          />
        </div>
      </div>
    </section>
  )
}
