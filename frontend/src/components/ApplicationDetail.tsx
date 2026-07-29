import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ApiError,
  getApplicationOnboarding,
  offboardApplicationOnboarding,
  syncApplicationOnboarding,
  type ApplicationOnboarding,
} from '../api/onboarding'
import { DeploymentTargetLogo, DeploymentTargetPanel } from './DeploymentTargetPanel'
import { DeployStepper } from './DeployStepper'
import { ResourceExplorer } from './ResourceExplorer'
import { Tabs } from './Tabs'

const pollIntervalMs = 5_000

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
  const [record, setRecord] = useState<ApplicationOnboarding | null>(null)
  const [loading, setLoading] = useState(true)
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState('')
  const [action, setAction] = useState<'sync' | 'offboard' | null>(null)
  const [actionMessage, setActionMessage] = useState('')
  const [actionError, setActionError] = useState('')
  const [confirmingOffboard, setConfirmingOffboard] = useState(false)
  const [activeTab, setActiveTab] = useState('targets')
  const [resourceTargetId, setResourceTargetId] = useState('')

  const load = useCallback(
    async (signal?: AbortSignal, quiet = false) => {
      if (!quiet) setLoading(true)
      try {
        const next = await getApplicationOnboarding(id, signal)
        setRecord(next)
        setMissing(false)
        setError('')
      } catch (loadError) {
        if (loadError instanceof DOMException && loadError.name === 'AbortError') return
        if (loadError instanceof ApiError && loadError.status === 404) {
          setMissing(true)
          setRecord(null)
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

  async function syncResources() {
    setAction('sync')
    setActionMessage('')
    setActionError('')
    try {
      const next = await syncApplicationOnboarding(id)
      setRecord(next)
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
    setAction('offboard')
    setActionMessage('')
    setActionError('')
    try {
      const next = await offboardApplicationOnboarding(id)
      setRecord(next)
      setConfirmingOffboard(false)
      if (next.status === 'offboarded') {
        // Nothing is left to operate on, so the application leaves the UI rather
        // than lingering as a dead row. The record and its GitHub values are kept,
        // and the offboarded status filter still finds it.
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

  const applicationScope = `${record.environment}-${record.region}`
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
          <div>
            <p className="kicker">GitOps delivery</p>
            <h1 id="application-heading">{record.name}</h1>
            <div className="detail-meta">
              <span className="mono">{record.namespace}</span>
              <span className="detail-meta-divider">·</span>
              <span className="environment-tag">{record.environment}</span>
              <span className="detail-meta-divider">·</span>
              <span className="mono">{record.region}</span>
            </div>
          </div>
          <div className="heading-actions">
            <button
              type="button"
              className="primary-button"
              disabled={action !== null || record.targets.length === 0}
              onClick={() => void syncResources()}
            >
              {action === 'sync'
                ? 'Syncing…'
                : record.status === 'offboarded'
                  ? 'Re-onboard from GitHub'
                  : 'Sync resources'}
            </button>
            <button
              type="button"
              className="danger-button"
              disabled={
                action !== null || record.status === 'offboarded' || record.targets.length === 0
              }
              onClick={() => setConfirmingOffboard(true)}
            >
              Offboard
            </button>
          </div>
        </div>
        <DeployStepper targets={record.targets} />
      </header>

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
        {record.region && (
          <nav className="region-rail" aria-label="Filter targets by environment and region">
            <p className="section-label">Deployment scope</p>
            <span className="region-rail-item is-active" aria-current="true">
              {applicationScope}
              <small>{record.targets.length}</small>
            </span>
          </nav>
        )}

        <div className="detail-panels">
          <Tabs
            label="Application details"
            activeId={activeTab}
            onChange={setActiveTab}
            items={[
              {
                id: 'targets',
                label: 'Deployment targets',
                content:
                  visibleTargets.length === 0 ? (
                    <div className="empty-panel">
                      This application has no deployment targets. Onboard it again with at least
                      one region.
                    </div>
                  ) : (
                    <>
                      <div className="section-heading section-heading--compact">
                        <div>
                          <h2>
                            {visibleTargets.length}{' '}
                            {visibleTargets.length === 1
                              ? 'Argo application'
                              : 'Argo applications'}
                          </h2>
                        </div>
                        <span className="quiet-note">Refreshes every 5 seconds</span>
                      </div>
                      <div className="target-grid">
                        {visibleTargets.map((target) => (
                          <DeploymentTargetPanel key={target.id} target={target} />
                        ))}
                      </div>
                    </>
                  ),
              },
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
