import { Fragment, useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  applicationsPageSize,
  getApplicationOnboardings,
  onboardingStatuses,
  type ApplicationOnboarding,
  type OnboardingStatus,
} from '../api/onboarding'
import { KubernetesLogo } from './BrandIcons'
import { RegionGroups } from './RegionGroups'
import { StateDelta, StateDeltaLegend } from './StateDelta'
import { StatusBadge } from './StatusBadge'
import { rollupState } from '../lib/status'

const pollIntervalMs = 10_000

function isStatus(value: string): value is OnboardingStatus {
  return (onboardingStatuses as string[]).includes(value)
}

function targetCountLabel(count: number) {
  return `${count} ${count === 1 ? 'target' : 'targets'}`
}

export function ApplicationsList() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [items, setItems] = useState<ApplicationOnboarding[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<string[]>([])

  // Filters live in the URL so a filtered list stays bookmarkable and shareable.
  const search = searchParams.get('search') ?? ''
  const statusParam = searchParams.get('status') ?? ''
  const status = isStatus(statusParam) ? statusParam : ''
  const page = Math.max(1, Number(searchParams.get('page')) || 1)

  const load = useCallback(
    async (signal?: AbortSignal, quiet = false) => {
      if (!quiet) setLoading(true)
      try {
        const result = await getApplicationOnboardings(
          { search, status, page, pageSize: applicationsPageSize },
          signal,
        )
        setItems(result.items)
        setTotal(result.total)
        setError('')
      } catch (loadError) {
        if (!(loadError instanceof DOMException && loadError.name === 'AbortError')) {
          setError(
            loadError instanceof Error ? loadError.message : 'Applications could not be loaded',
          )
        }
      } finally {
        if (!quiet) setLoading(false)
      }
    },
    [page, search, status],
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

  function updateParams(changes: Record<string, string>, resetPage = true) {
    const next = new URLSearchParams(searchParams)
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value)
      else next.delete(key)
    }
    if (resetPage) next.delete('page')
    setSearchParams(next, { replace: true })
  }

  function toggleExpanded(id: string) {
    setExpanded((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    )
  }

  const totalPages = Math.max(1, Math.ceil(total / applicationsPageSize))

  return (
    <section className="applications-page" aria-labelledby="applications-heading">
      <header className="page-heading applications-heading">
        <div className="applications-heading-copy">
          <h1 id="applications-heading">Onboarded applications</h1>
          <p>Inspect releases, target health, and reconciliation across the fleet.</p>
        </div>
        <Link className="primary-button" to="/applications/new">
          Onboard application
        </Link>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          <div>
            <strong>Applications could not be loaded</strong>
            <span>{error}</span>
          </div>
          <button type="button" className="text-button" onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}

      <section className="application-filter-deck" aria-label="Filter applications">
        <div className="application-filter-grid">
          <label className="application-filter-control application-search-control">
            <span>Application or namespace</span>
            <span className="application-search-field">
              <span className="search-icon" aria-hidden="true">⌕</span>
              <input
                aria-label="Search applications by name or namespace"
                type="search"
                placeholder="Search applications"
                value={search}
                onChange={(event) => updateParams({ search: event.target.value })}
              />
            </span>
          </label>
          <label className="application-filter-control">
            <span>Status</span>
            <select
              value={status}
              onChange={(event) => updateParams({ status: event.target.value })}
            >
              <option value="">All statuses</option>
              {onboardingStatuses.map((item) => (
                <option value={item} key={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
        </div>

        {(search || status) && (
          <div className="application-active-filters">
            <div className="filter-chips">
              {search && (
                <span className="chip">
                  Name <strong>{search}</strong>
                  <button
                    type="button"
                    className="chip-remove"
                    aria-label={`Remove name filter ${search}`}
                    onClick={() => updateParams({ search: '' })}
                  >
                    ×
                  </button>
                </span>
              )}
              {status && (
                <span className="chip">
                  Status <strong>{status}</strong>
                  <button
                    type="button"
                    className="chip-remove"
                    aria-label={`Remove status filter ${status}`}
                    onClick={() => updateParams({ status: '' })}
                  >
                    ×
                  </button>
                </span>
              )}
            </div>
            <button
              type="button"
              className="clear-filters"
              onClick={() => updateParams({ search: '', status: '' })}
            >
              Clear filters
            </button>
          </div>
        )}
      </section>

      <div className="table-frame">
        {loading ? (
          <div className="table-state" role="status">
            <span className="loader" aria-hidden="true" />
            Loading applications…
          </div>
        ) : items.length === 0 ? (
          <div className="table-state">
            <KubernetesLogo className="empty-kubernetes-logo" />
            {search || status ? (
              <>
                <strong>Nothing matches those filters</strong>
                <span>Try a different search, or clear the filters to see everything.</span>
              </>
            ) : (
              <>
                <strong>No applications onboarded yet</strong>
                <span>Onboard one and its clusters, sync state, and health show up here.</span>
              </>
            )}
          </div>
        ) : (
          <>
            <StateDeltaLegend />
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th className="expander-cell" aria-label="Expand row" />
                    <th>Application</th>
                    <th>Namespace</th>
                    <th>Environment</th>
                    <th>Region</th>
                    <th>Targets</th>
                    <th>Reconciliation</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const isExpanded = expanded.includes(item.id)
                    const rollup = rollupState(item.targets)
                    return (
                      <Fragment key={item.id}>
                        <tr
                          className="row-clickable"
                          onClick={() => void navigate(`/applications/${item.id}`)}
                        >
                          <td className="expander-cell">
                            <button
                              type="button"
                              className="row-expander"
                              aria-expanded={isExpanded}
                              aria-label={`${isExpanded ? 'Hide' : 'Show'} deployment targets for ${
                                item.name
                              }`}
                              onClick={(event) => {
                                // The row navigates; the expander must not.
                                event.stopPropagation()
                                toggleExpanded(item.id)
                              }}
                            >
                              <svg viewBox="0 0 12 12" aria-hidden="true">
                                <path
                                  d="M4 2l4 4-4 4"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.8"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            </button>
                          </td>
                          <td>
                            <Link className="application-name" to={`/applications/${item.id}`}>
                              {item.name}
                            </Link>
                          </td>
                          <td className="mono">{item.namespace}</td>
                          <td><span className="environment-tag">{item.environment}</span></td>
                          <td className="mono">{item.region || '—'}</td>
                          <td>{targetCountLabel(item.targets.length)}</td>
                          <td>
                            <StateDelta
                              syncStatus={rollup.syncStatus}
                              healthStatus={rollup.healthStatus}
                            />
                          </td>
                          <td>
                            <StatusBadge status={item.status} />
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr className="expanded-row">
                            <td colSpan={8}>
                              {item.targets.length === 0 ? (
                                <div className="region-groups">
                                  <p className="quiet-note">
                                    This application has no deployment targets.
                                  </p>
                                </div>
                              ) : (
                                <RegionGroups
                                  targets={item.targets}
                                  revision={item.valuesCommitSha}
                                />
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
        <div className="pagination">
          <span>
            Page {page} of {totalPages} · {total} applications
          </span>
          <div className="pagination-controls">
            <button
              type="button"
              disabled={page === 1}
              onClick={() => updateParams({ page: String(page - 1) }, false)}
            >
              Previous
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => updateParams({ page: String(page + 1) }, false)}
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
