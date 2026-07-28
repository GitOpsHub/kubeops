import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ApiError,
  getApplicationOnboarding,
  type ApplicationOnboarding,
  type OnboardingStatus,
} from '../api/onboarding'
import { DeploymentTargetPanel } from './DeploymentTargetPanel'

const pollIntervalMs = 5_000

const statusSummaries: Record<OnboardingStatus, string> = {
  progressing: 'Argo CD is still reconciling one or more targets.',
  healthy: 'Every target is synced and healthy.',
  partial: 'Some targets are healthy while others failed.',
  failed: 'Every target failed to reach a healthy state.',
}

export function ApplicationDetail() {
  const { id = '' } = useParams()
  const [record, setRecord] = useState<ApplicationOnboarding | null>(null)
  const [loading, setLoading] = useState(true)
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState('')

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

  if (missing) {
    return (
      <section className="application-detail" aria-labelledby="application-heading">
        <Link className="text-button onboarding-back" to="/applications">
          ← Applications
        </Link>
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
        <Link className="text-button onboarding-back" to="/applications">
          ← Applications
        </Link>
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

  const regions = [...new Set(record.targets.map((target) => target.region).filter(Boolean))].sort()

  return (
    <section className="application-detail" aria-labelledby="application-heading">
      <Link className="text-button onboarding-back" to="/applications">
        ← Applications
      </Link>

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

      <header className="page-heading">
        <div>
          <p className="kicker">GitOps delivery</p>
          <h1 id="application-heading">{record.name}</h1>
          <p>
            {record.namespace} · {regions.length > 0 ? regions.join(', ') : 'no region'} ·{' '}
            {statusSummaries[record.status]}
          </p>
        </div>
        <div className="heading-actions">
          <span className={`deployment-pill deployment-pill--${record.status}`}>
            {record.status}
          </span>
        </div>
      </header>

      <dl className="application-facts">
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
          <dt>Values digest</dt>
          <dd className="mono">{record.valuesDigest}</dd>
        </div>
      </dl>

      <div className="section-heading section-heading--compact">
        <div>
          <p className="section-label">Deployment targets</p>
          <h2>
            {record.targets.length}{' '}
            {record.targets.length === 1 ? 'Argo application' : 'Argo applications'}
          </h2>
        </div>
        <span className="quiet-note">Refreshes every 5 seconds</span>
      </div>

      {record.targets.length === 0 ? (
        <div className="empty-panel">
          This application has no deployment targets. Onboard it again with at least one region.
        </div>
      ) : (
        <div className="target-grid">
          {record.targets.map((target) => (
            <DeploymentTargetPanel key={target.id} target={target} />
          ))}
        </div>
      )}
    </section>
  )
}
