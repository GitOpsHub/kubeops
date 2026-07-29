import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
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
const applicationFetchPageSize = 200
const environmentOrder = ['dev', 'qa', 'prod']

function isStatus(value: string): value is OnboardingStatus {
  return (onboardingStatuses as string[]).includes(value)
}

function targetCountLabel(count: number) {
  return `${count} ${count === 1 ? 'target' : 'targets'}`
}

function releaseCountLabel(count: number) {
  return `${count} ${count === 1 ? 'release' : 'releases'}`
}

function groupStatus(records: ApplicationOnboarding[]): OnboardingStatus {
  const statuses = new Set(records.map((record) => record.status))
  if (statuses.size === 1) return records[0].status
  if (statuses.has('failed') || statuses.has('partial')) return 'partial'
  if (statuses.has('progressing')) return 'progressing'
  if (statuses.has('healthy')) return 'partial'
  return 'offboarded'
}

function uniqueSorted(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right))
}

function compareEnvironments(left: string, right: string) {
  const leftIndex = environmentOrder.indexOf(left)
  const rightIndex = environmentOrder.indexOf(right)
  if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right)
  if (leftIndex === -1) return 1
  if (rightIndex === -1) return -1
  return leftIndex - rightIndex
}

function groupReleasesByEnvironment(records: ApplicationOnboarding[]) {
  const groups = new Map<string, ApplicationOnboarding[]>()
  for (const record of records) {
    const current = groups.get(record.environment)
    if (current) current.push(record)
    else groups.set(record.environment, [record])
  }
  return [...groups.entries()]
    .sort(([left], [right]) => compareEnvironments(left, right))
    .map(([environment, releases]) => ({
      environment,
      releases: releases.sort((left, right) => left.region.localeCompare(right.region)),
    }))
}

function groupApplications(records: ApplicationOnboarding[]) {
  const groups = new Map<string, ApplicationOnboarding[]>()
  for (const record of records) {
    const key = record.name.trim().toLocaleLowerCase()
    const current = groups.get(key)
    if (current) current.push(record)
    else groups.set(key, [record])
  }

  return [...groups.entries()].map(([key, groupedRecords]) => {
    const recordsByScope = [...groupedRecords].sort(
      (left, right) =>
        compareEnvironments(left.environment, right.environment) ||
        left.region.localeCompare(right.region),
    )
    const targets = recordsByScope.flatMap((record) => record.targets)
    const identityRecord = [...recordsByScope].sort(
      (left, right) =>
        new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime() ||
        left.id.localeCompare(right.id),
    )[0]
    return {
      key,
      name: recordsByScope[0].name,
      // The first persisted onboarding ID anchors the logical group, so adding
      // another regional release later does not renumber the application.
      applicationId: identityRecord.id,
      records: recordsByScope,
      targets,
      namespaces: uniqueSorted(recordsByScope.map((record) => record.namespace)),
      environments: uniqueSorted(recordsByScope.map((record) => record.environment)),
      regions: uniqueSorted(recordsByScope.map((record) => record.region)),
      platformIds: uniqueSorted(targets.map((target) => target.sourceId)),
      status: groupStatus(recordsByScope),
    }
  })
}

export function ApplicationsList() {
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
        const loaded: ApplicationOnboarding[] = []
        let apiPage = 1
        let resultTotal = 0
        do {
          const result = await getApplicationOnboardings(
            { search, status, page: apiPage, pageSize: applicationFetchPageSize },
            signal,
          )
          loaded.push(...result.items)
          resultTotal = result.total
          apiPage += 1
        } while (loaded.length < resultTotal)
        setItems(loaded)
        setTotal(resultTotal)
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
    [search, status],
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

  const groups = useMemo(() => groupApplications(items), [items])
  const totalPages = Math.max(1, Math.ceil(groups.length / applicationsPageSize))
  const visibleGroups = groups.slice(
    (page - 1) * applicationsPageSize,
    page * applicationsPageSize,
  )

  useEffect(() => {
    if (loading || page <= totalPages) return
    const next = new URLSearchParams(searchParams)
    next.set('page', String(totalPages))
    setSearchParams(next, { replace: true })
  }, [loading, page, searchParams, setSearchParams, totalPages])

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
        ) : groups.length === 0 ? (
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
                    <th>Platform ID</th>
                    <th>Namespace</th>
                    <th>Environment</th>
                    <th>Region</th>
                    <th>Releases / targets</th>
                    <th>Reconciliation</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleGroups.map((group) => {
                    const isExpanded = expanded.includes(group.key)
                    const rollup = rollupState(group.targets)
                    const primaryRecord = group.records[0]
                    return (
                      <Fragment key={group.key}>
                        <tr>
                          <td className="expander-cell">
                            <button
                              type="button"
                              className="row-expander"
                              aria-expanded={isExpanded}
                              aria-label={`${isExpanded ? 'Hide' : 'Show'} deployment targets for ${
                                group.name
                              }`}
                              onClick={(event) => {
                                event.stopPropagation()
                                toggleExpanded(group.key)
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
                            <Link
                              className="application-name"
                              to={`/applications/${primaryRecord.id}`}
                            >
                              {group.name}
                            </Link>
                            <span className="application-id" title={group.applicationId}>
                              ID {group.applicationId}
                            </span>
                          </td>
                          <td>
                            <div className="platform-id-list">
                              {group.platformIds.length > 0
                                ? group.platformIds.map((platformId) => (
                                    <span className="platform-id" key={platformId}>
                                      {platformId}
                                    </span>
                                  ))
                                : '—'}
                            </div>
                          </td>
                          <td className="mono">
                            {group.namespaces.length === 1
                              ? group.namespaces[0]
                              : `${group.namespaces.length} namespaces`}
                          </td>
                          <td>
                            <div className="environment-list">
                              {group.environments.map((environment) => (
                                <span className="environment-tag" key={environment}>
                                  {environment}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td className="mono">{group.regions.join(', ') || '—'}</td>
                          <td>
                            <span className="release-target-count">
                              {releaseCountLabel(group.records.length)}
                              <small>{targetCountLabel(group.targets.length)}</small>
                            </span>
                          </td>
                          <td>
                            <StateDelta
                              syncStatus={rollup.syncStatus}
                              healthStatus={rollup.healthStatus}
                            />
                          </td>
                          <td>
                            <StatusBadge status={group.status} />
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr className="expanded-row">
                            <td colSpan={9}>
                              <div className="application-release-groups">
                                {groupReleasesByEnvironment(group.records).map(
                                  ({ environment, releases }) => (
                                    <section
                                      className={`application-environment-group application-environment-group--${environment}`}
                                      key={environment}
                                      aria-label={`${environment} releases`}
                                    >
                                      <header className="application-environment-heading">
                                        <div>
                                          <span
                                            className="application-environment-marker"
                                            aria-hidden="true"
                                          />
                                          <strong>{environment}</strong>
                                          <span>environment</span>
                                        </div>
                                        <small>
                                          {releases.length}{' '}
                                          {releases.length === 1
                                            ? 'regional release'
                                            : 'regional releases'}
                                        </small>
                                      </header>
                                      <div className="application-environment-releases">
                                        {releases.map((record) => (
                                          <section
                                            className="application-release"
                                            key={record.id}
                                            aria-label={`Release ${record.environment}-${record.region}`}
                                          >
                                            <header className="application-release-heading">
                                              <div className="application-release-identity">
                                                <span>Region</span>
                                                <strong>{record.region}</strong>
                                                <code>{record.namespace}</code>
                                              </div>
                                              <div className="application-release-actions">
                                                {record.targets.length > 1 && (
                                                  <StatusBadge status={record.status} />
                                                )}
                                                <Link
                                                  to={`/applications/${record.id}`}
                                                  aria-label={`Open ${record.environment}-${record.region} application view`}
                                                >
                                                  <svg viewBox="0 0 16 16" aria-hidden="true">
                                                    <path d="M3 8h9M8.5 3.5 13 8l-4.5 4.5" />
                                                  </svg>
                                                </Link>
                                              </div>
                                            </header>
                                            {record.targets.length === 0 ? (
                                              <p className="quiet-note">
                                                This release has no deployment targets.
                                              </p>
                                            ) : (
                                              <RegionGroups
                                                targets={record.targets}
                                                environment={record.environment}
                                                revision={record.valuesCommitSha}
                                                showScopeName={false}
                                              />
                                            )}
                                          </section>
                                        ))}
                                      </div>
                                    </section>
                                  ),
                                )}
                              </div>
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
            Page {page} of {totalPages} · {groups.length}{' '}
            {groups.length === 1 ? 'application' : 'applications'} · {total}{' '}
            {total === 1 ? 'release' : 'releases'}
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
