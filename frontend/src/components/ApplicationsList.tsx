import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  getApplicationOnboardings,
  onboardingStatuses,
  type ApplicationDeployment,
  type ApplicationOnboarding,
  type OnboardingStatus,
} from '../api/onboarding'
import { ArgoHealthState, ArgoSyncState } from './ArgoStateIcons'
import { KubernetesLogo } from './BrandIcons'
import { StateDelta, StateDeltaLegend } from './StateDelta'
import { StatusBadge } from './StatusBadge'
import { useStoredPreference } from '../hooks/useStoredPreference'
import { deltaTone, rollupState } from '../lib/status'

const pollIntervalMs = 10_000
const applicationFetchPageSize = 200
// A guard rail, not a target: without it a server that reports a larger `total`
// than it can page through spins this loop forever.
const applicationFetchPageCap = 25
const environmentOrder = ['dev', 'qa', 'prod']
const visiblePlatformIds = 2
const searchDebounceMs = 250
const pageSizeOptions = [25, 50, 100]
const defaultPageSize = 50

type SortKey = 'name' | 'targets' | 'status'
type SortDirection = 'asc' | 'desc'
type ViewMode = 'tiles' | 'table'

const sortLabels: Record<SortKey, string> = {
  name: 'Name',
  targets: 'Releases',
  status: 'Status',
}

// Worst first: the reason to sort by status is to find what is broken.
const statusSeverity: Record<OnboardingStatus, number> = {
  failed: 0,
  partial: 1,
  progressing: 2,
  healthy: 3,
  offboarded: 4,
}

const toneClass: Record<string, string> = {
  converged: 'application-target-row--ok',
  reconciling: 'application-target-row--warn',
  diverged: 'application-target-row--err',
  unknown: '',
}

function isStatus(value: string): value is OnboardingStatus {
  return (onboardingStatuses as string[]).includes(value)
}

function isSortKey(value: string): value is SortKey {
  return value === 'name' || value === 'targets' || value === 'status'
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

type TargetRow = {
  key: string
  releaseId: string
  environment: string
  region: string
  namespace: string
  target: ApplicationDeployment | null
}

/**
 * The expanded row answers one question — where does this run and is it well —
 * so every target is one line, ordered the way an operator promotes: dev first,
 * then region, then cluster. Releases without targets still get a line so a
 * half-finished onboarding is visible rather than absent.
 */
function flattenTargets(records: ApplicationOnboarding[]): TargetRow[] {
  const rows: TargetRow[] = []
  for (const record of records) {
    if (record.targets.length === 0) {
      rows.push({
        key: record.id,
        releaseId: record.id,
        environment: record.environment,
        region: record.region,
        namespace: record.namespace,
        target: null,
      })
      continue
    }
    for (const target of record.targets) {
      rows.push({
        key: target.id,
        releaseId: record.id,
        environment: record.environment,
        region: target.region || record.region,
        namespace: record.namespace,
        target,
      })
    }
  }
  return rows.sort(
    (left, right) =>
      compareEnvironments(left.environment, right.environment) ||
      left.region.localeCompare(right.region) ||
      (left.target?.clusterName ?? '').localeCompare(right.target?.clusterName ?? ''),
  )
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
      // another regional release later does not renumber the application. It is
      // also the ID every link on the row opens, so what is shown and what is
      // opened cannot drift apart.
      applicationId: identityRecord.id,
      records: recordsByScope,
      targets,
      namespaces: uniqueSorted(recordsByScope.map((record) => record.namespace)),
      // Promotion order, not alphabetical: "dev qa prod" is how the row is read.
      environments: [...new Set(recordsByScope.map((record) => record.environment))]
        .filter(Boolean)
        .sort(compareEnvironments),
      regions: uniqueSorted(recordsByScope.map((record) => record.region)),
      platformIds: uniqueSorted(targets.map((target) => target.sourceId)),
      status: groupStatus(recordsByScope),
    }
  })
}

type ApplicationGroup = ReturnType<typeof groupApplications>[number]

function matchesSearch(group: ApplicationGroup, term: string) {
  if (!term) return true
  const needle = term.trim().toLocaleLowerCase()
  if (!needle) return true
  return (
    group.name.toLocaleLowerCase().includes(needle) ||
    group.namespaces.some((namespace) => namespace.toLocaleLowerCase().includes(needle))
  )
}

function compareGroups(left: ApplicationGroup, right: ApplicationGroup, key: SortKey) {
  if (key === 'targets') {
    return left.targets.length - right.targets.length || left.name.localeCompare(right.name)
  }
  if (key === 'status') {
    return (
      statusSeverity[left.status] - statusSeverity[right.status] ||
      left.name.localeCompare(right.name)
    )
  }
  return left.name.localeCompare(right.name)
}

export function ApplicationsList() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [items, setItems] = useState<ApplicationOnboarding[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<string[]>([])
  // Argo-style tiles are the default read; the table remains one click away for
  // operators who want columns to sort and compare.
  const [view, setView] = useStoredPreference<ViewMode>('kubeops.applications.view', 'tiles')

  // Filters live in the URL so a filtered list stays bookmarkable and shareable.
  const search = searchParams.get('search') ?? ''
  const statusParam = searchParams.get('status') ?? ''
  const status = isStatus(statusParam) ? statusParam : ''
  const environment = searchParams.get('environment') ?? ''
  const sortParam = searchParams.get('sort') ?? ''
  const sortKey: SortKey = isSortKey(sortParam) ? sortParam : 'name'
  const sortDirection: SortDirection = searchParams.get('dir') === 'desc' ? 'desc' : 'asc'
  const page = Math.max(1, Number(searchParams.get('page')) || 1)
  const pageSizeParam = Number(searchParams.get('pageSize'))
  const pageSize = pageSizeOptions.includes(pageSizeParam) ? pageSizeParam : defaultPageSize

  const [searchDraft, setSearchDraft] = useState(search)

  const updateParams = useCallback(
    (changes: Record<string, string>, resetPage = true) => {
      const next = new URLSearchParams(searchParams)
      for (const [key, value] of Object.entries(changes)) {
        if (value) next.set(key, value)
        else next.delete(key)
      }
      if (resetPage) next.delete('page')
      setSearchParams(next, { replace: true })
    },
    [searchParams, setSearchParams],
  )

  // Offboarded releases are excluded server-side unless asked for by name, so
  // that one status is the only filter the API is allowed to see. Everything
  // else is applied after grouping — filtering releases would otherwise hide
  // part of an application and leave the row claiming a status it does not have.
  const includeOffboarded = status === 'offboarded'

  const load = useCallback(
    async (signal?: AbortSignal, quiet = false) => {
      if (!quiet) setLoading(true)
      try {
        const loaded: ApplicationOnboarding[] = []
        let apiPage = 1
        let resultTotal = 0
        do {
          const result = await getApplicationOnboardings(
            {
              status: includeOffboarded ? 'offboarded' : '',
              page: apiPage,
              pageSize: applicationFetchPageSize,
            },
            signal,
          )
          if (result.items.length === 0) break
          loaded.push(...result.items)
          resultTotal = result.total
          apiPage += 1
        } while (loaded.length < resultTotal && apiPage <= applicationFetchPageCap)
        setItems(loaded)
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
    [includeOffboarded],
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

  // Typing filters a list already in memory, but it still re-renders every row;
  // the pause keeps a 100-row table responsive and the URL out of the way.
  useEffect(() => {
    if (searchDraft === search) return
    const timer = window.setTimeout(() => updateParams({ search: searchDraft }), searchDebounceMs)
    return () => window.clearTimeout(timer)
  }, [search, searchDraft, updateParams])

  function toggleExpanded(id: string) {
    setExpanded((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    )
  }

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      updateParams({ sort: key, dir: sortDirection === 'asc' ? 'desc' : 'asc' })
      return
    }
    updateParams({ sort: key, dir: 'asc' })
  }

  function clearSearch() {
    setSearchDraft('')
    updateParams({ search: '' })
  }

  function clearAllFilters() {
    setSearchDraft('')
    updateParams({ search: '', status: '', environment: '' })
  }

  const groups = useMemo(() => groupApplications(items), [items])

  const environmentOptions = useMemo(
    () =>
      [...new Set(groups.flatMap((group) => group.environments))].sort(compareEnvironments),
    [groups],
  )

  // Status counts describe the set the operator is looking at, minus the status
  // filter itself — otherwise picking one collapses every other count to zero.
  const scopedGroups = useMemo(
    () =>
      groups.filter(
        (group) =>
          matchesSearch(group, search) &&
          (!environment || group.environments.includes(environment)),
      ),
    [groups, search, environment],
  )

  const statusCounts = useMemo(() => {
    const counts = new Map<OnboardingStatus, number>()
    for (const group of scopedGroups) {
      counts.set(group.status, (counts.get(group.status) ?? 0) + 1)
    }
    return onboardingStatuses
      .map((item) => ({ status: item, count: counts.get(item) ?? 0 }))
      .filter((entry) => entry.count > 0)
  }, [scopedGroups])

  const filteredGroups = useMemo(() => {
    const matched = status ? scopedGroups.filter((group) => group.status === status) : scopedGroups
    const direction = sortDirection === 'desc' ? -1 : 1
    return [...matched].sort((left, right) => compareGroups(left, right, sortKey) * direction)
  }, [scopedGroups, status, sortKey, sortDirection])

  const totalPages = Math.max(1, Math.ceil(filteredGroups.length / pageSize))
  const firstIndex = (page - 1) * pageSize
  const visibleGroups = filteredGroups.slice(firstIndex, firstIndex + pageSize)
  const hasFilters = Boolean(search || status || environment)

  useEffect(() => {
    if (loading || page <= totalPages) return
    const next = new URLSearchParams(searchParams)
    next.set('page', String(totalPages))
    setSearchParams(next, { replace: true })
  }, [loading, page, searchParams, setSearchParams, totalPages])

  // Rows that scroll or filter out of view do not stay armed to reopen when
  // they come back.
  useEffect(() => {
    const visibleKeys = new Set(visibleGroups.map((group) => group.key))
    setExpanded((current) => {
      const next = current.filter((key) => visibleKeys.has(key))
      return next.length === current.length ? current : next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, search, status, environment, sortKey, sortDirection])

  function sortStateFor(key: SortKey) {
    if (key !== sortKey) return 'none' as const
    return sortDirection === 'asc' ? ('ascending' as const) : ('descending' as const)
  }

  function sortableHeader(key: SortKey, label: string) {
    return (
      <button
        type="button"
        className={`column-sort${key === sortKey ? ' is-active' : ''}`}
        onClick={() => toggleSort(key)}
      >
        {label}
        <span className="column-sort-caret" aria-hidden="true">
          {key === sortKey ? (sortDirection === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </button>
    )
  }

  return (
    <section className="applications-page" aria-labelledby="applications-heading">
      <header className="page-heading applications-heading">
        <div className="applications-heading-copy">
          <h1 id="applications-heading">Onboarded applications</h1>
          <p>Inspect releases, target health, and reconciliation across the fleet.</p>
        </div>
        <div className="applications-heading-actions">
          <div className="view-toggle" role="group" aria-label="Applications view">
            <button
              type="button"
              className={view === 'tiles' ? 'is-active' : ''}
              aria-pressed={view === 'tiles'}
              title="Tile view"
              onClick={() => setView('tiles')}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <rect x="1.5" y="1.5" width="5.4" height="5.4" rx="1.2" />
                <rect x="9.1" y="1.5" width="5.4" height="5.4" rx="1.2" />
                <rect x="1.5" y="9.1" width="5.4" height="5.4" rx="1.2" />
                <rect x="9.1" y="9.1" width="5.4" height="5.4" rx="1.2" />
              </svg>
              Tiles
            </button>
            <button
              type="button"
              className={view === 'table' ? 'is-active' : ''}
              aria-pressed={view === 'table'}
              title="Table view"
              onClick={() => setView('table')}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <rect x="1.5" y="2.2" width="13" height="2.6" rx="1" />
                <rect x="1.5" y="6.7" width="13" height="2.6" rx="1" />
                <rect x="1.5" y="11.2" width="13" height="2.6" rx="1" />
              </svg>
              Table
            </button>
          </div>
          <Link className="primary-button" to="/applications/new">
            Onboard application
          </Link>
        </div>
      </header>

      {/* With rows already on screen a failed poll is a stale-data warning. With
          nothing on screen it is still a load in progress, and the table below
          says so rather than claiming the fleet is empty. */}
      {error && items.length > 0 && (
        <div className="error-banner" role="alert">
          <div>
            <strong>Applications could not be refreshed</strong>
            <span>{error}</span>
          </div>
          <button type="button" className="text-button" onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}

      <section className="application-filter-deck" aria-label="Filter applications">
        <div
          className={`application-filter-grid${
            view === 'tiles' ? ' application-filter-grid--with-sort' : ''
          }`}
        >
          <label className="application-filter-control application-search-control">
            <span>Application or namespace</span>
            <span className="application-search-field">
              <span className="search-icon" aria-hidden="true">⌕</span>
              <input
                aria-label="Search applications by name or namespace"
                type="search"
                placeholder="Search applications"
                value={searchDraft}
                onChange={(event) => setSearchDraft(event.target.value)}
              />
            </span>
          </label>
          <label className="application-filter-control">
            <span>Environment</span>
            <select
              value={environment}
              onChange={(event) => updateParams({ environment: event.target.value })}
            >
              <option value="">All environments</option>
              {environmentOptions.map((item) => (
                <option value={item} key={item}>
                  {item}
                </option>
              ))}
            </select>
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
          {/* The table sorts from its headers; tiles have no headers, so the
              same sort state gets a control of its own. */}
          {view === 'tiles' && (
            <label className="application-filter-control">
              <span>Sort by</span>
              <div className="tile-sort-control">
                <select
                  value={sortKey}
                  onChange={(event) => updateParams({ sort: event.target.value })}
                >
                  {(Object.keys(sortLabels) as SortKey[]).map((key) => (
                    <option value={key} key={key}>
                      {sortLabels[key]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  aria-label={`Sort ${sortDirection === 'asc' ? 'descending' : 'ascending'}`}
                  title={sortDirection === 'asc' ? 'Ascending' : 'Descending'}
                  onClick={() =>
                    updateParams({ sort: sortKey, dir: sortDirection === 'asc' ? 'desc' : 'asc' })
                  }
                >
                  {sortDirection === 'asc' ? '↑' : '↓'}
                </button>
              </div>
            </label>
          )}
        </div>

        {/* At a hundred rows the fastest question is "what is broken", and the
            answer should be one click, not a trip through a select. */}
        {statusCounts.length > 0 && (
          <div className="application-status-summary" role="group" aria-label="Filter by status">
            {statusCounts.map((entry) => (
              <button
                type="button"
                key={entry.status}
                className={`status-summary-chip status-summary-chip--${entry.status}${
                  status === entry.status ? ' is-active' : ''
                }`}
                aria-pressed={status === entry.status}
                onClick={() =>
                  updateParams({ status: status === entry.status ? '' : entry.status })
                }
              >
                <strong>{entry.count}</strong> {entry.status}
              </button>
            ))}
          </div>
        )}

        {hasFilters && (
          <div className="application-active-filters">
            <div className="filter-chips">
              {search && (
                <span className="chip">
                  Name <strong>{search}</strong>
                  <button
                    type="button"
                    className="chip-remove"
                    aria-label={`Remove name filter ${search}`}
                    onClick={clearSearch}
                  >
                    ×
                  </button>
                </span>
              )}
              {environment && (
                <span className="chip">
                  Environment <strong>{environment}</strong>
                  <button
                    type="button"
                    className="chip-remove"
                    aria-label={`Remove environment filter ${environment}`}
                    onClick={() => updateParams({ environment: '' })}
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
            <button type="button" className="clear-filters" onClick={clearAllFilters}>
              Clear filters
            </button>
          </div>
        )}
      </section>

      <div className={view === 'tiles' ? 'application-tiles-frame' : 'table-frame'}>
        {loading || (error && items.length === 0) ? (
          <div className="retry-state" role="status">
            <span className="loader" aria-hidden="true" />
            <strong>Loading applications…</strong>
            {error && <span>Last attempt failed: {error}</span>}
            {!loading && error && (
              <button type="button" className="text-button" onClick={() => void load()}>
                Try again
              </button>
            )}
          </div>
        ) : filteredGroups.length === 0 ? (
          <div className="table-state">
            <KubernetesLogo className="empty-kubernetes-logo" />
            {hasFilters ? (
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
        ) : view === 'tiles' ? (
          <div className="application-card-grid">
            {visibleGroups.map((group) => {
              const rollup = rollupState(group.targets)
              const cardTone = deltaTone(rollup.syncStatus, rollup.healthStatus)
              const namespaceLabel =
                group.namespaces.length === 1
                  ? group.namespaces[0]
                  : `${group.namespaces.length} namespaces`
              const argoUrl = group.targets.find(
                (target) => target.argoApplicationUrl,
              )?.argoApplicationUrl
              const overflowPlatformIds = group.platformIds.slice(visiblePlatformIds)
              return (
                <article
                  className={`application-card application-card--${cardTone}`}
                  key={group.key}
                >
                  <header className="application-card-head">
                    <div className="application-card-identity">
                      <Link
                        className="application-card-name"
                        to={`/applications/${group.applicationId}`}
                        title={`${group.name} · ${group.applicationId}`}
                      >
                        {group.name}
                      </Link>
                      <span className="application-card-namespace" title={namespaceLabel}>
                        {namespaceLabel}
                      </span>
                    </div>
                    <StatusBadge status={group.status} />
                  </header>
                  <div className="application-card-states">
                    <ArgoHealthState status={rollup.healthStatus} />
                    <ArgoSyncState status={rollup.syncStatus} />
                  </div>
                  <dl className="application-card-facts">
                    <div>
                      <dt>Environments</dt>
                      <dd>
                        <span className="environment-list">
                          {group.environments.length > 0
                            ? group.environments.map((item) => (
                                <span className="environment-tag" key={item}>
                                  {item}
                                </span>
                              ))
                            : '—'}
                        </span>
                      </dd>
                    </div>
                    <div>
                      <dt>Regions</dt>
                      <dd>
                        <span className="region-run" title={group.regions.join(', ')}>
                          {group.regions.length > 0 ? group.regions.join(' · ') : '—'}
                        </span>
                      </dd>
                    </div>
                    <div className="application-card-fact--wide">
                      <dt>Platforms</dt>
                      <dd>
                        <span className="platform-id-list">
                          {group.platformIds.length > 0
                            ? group.platformIds.slice(0, visiblePlatformIds).map((platformId) => (
                                <span className="platform-id" key={platformId} title={platformId}>
                                  {platformId}
                                </span>
                              ))
                            : '—'}
                          {overflowPlatformIds.length > 0 && (
                            <span
                              className="platform-id platform-id--more"
                              title={overflowPlatformIds.join(', ')}
                            >
                              +{overflowPlatformIds.length}
                            </span>
                          )}
                        </span>
                      </dd>
                    </div>
                  </dl>
                  <footer className="application-card-foot">
                    <span className="application-card-counts">
                      {`${releaseCountLabel(group.records.length)} · ${targetCountLabel(
                        group.targets.length,
                      )}`}
                    </span>
                    {argoUrl && (
                      <a
                        className="application-card-argo"
                        href={argoUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Argo CD
                        <svg viewBox="0 0 12 12" aria-hidden="true">
                          <path
                            d="M4.5 2h5.5v5.5M10 2 4 8"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </a>
                    )}
                  </footer>
                </article>
              )
            })}
          </div>
        ) : (
          <>
            <StateDeltaLegend />
            <div className="table-scroll">
              <table className="applications-table">
                <thead>
                  <tr>
                    <th className="expander-cell" aria-label="Expand row" />
                    <th className="col-app" aria-sort={sortStateFor('name')}>
                      {sortableHeader('name', 'Application')}
                    </th>
                    <th className="col-platform">Platform</th>
                    <th className="col-scope">Scope</th>
                    <th className="col-delivery" aria-sort={sortStateFor('targets')}>
                      {sortableHeader('targets', 'Releases')}
                    </th>
                    <th className="col-recon">Reconciliation</th>
                    <th className="col-status" aria-sort={sortStateFor('status')}>
                      {sortableHeader('status', 'Status')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visibleGroups.map((group) => {
                    const isExpanded = expanded.includes(group.key)
                    const rollup = rollupState(group.targets)
                    const namespaceLabel =
                      group.namespaces.length === 1
                        ? group.namespaces[0]
                        : `${group.namespaces.length} namespaces`
                    const overflowPlatformIds = group.platformIds.slice(visiblePlatformIds)
                    const targetsRowId = `application-targets-${group.key}`
                    return (
                      <Fragment key={group.key}>
                        <tr>
                          <td className="expander-cell">
                            <button
                              type="button"
                              className="row-expander"
                              aria-expanded={isExpanded}
                              aria-controls={targetsRowId}
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
                          {/* Namespace rides under the name rather than owning a
                              column: it is how you confirm the row, not how you
                              scan the table. The UUID is never read at a
                              hundred rows — it hangs off the title and the
                              expanded header, where it can be copied. */}
                          <td className="col-app">
                            <Link
                              className="application-name"
                              to={`/applications/${group.applicationId}`}
                              title={`${group.name} · ${group.applicationId}`}
                            >
                              {group.name}
                            </Link>
                            <span className="application-namespace" title={namespaceLabel}>
                              {namespaceLabel}
                            </span>
                          </td>
                          {/* An application spread over six platforms stacked six
                              chips and made one row as tall as four. Two are shown
                              and the rest collapse into a counter that names them
                              on hover; the expanded row lists them all. */}
                          <td className="col-platform">
                            <div className="platform-id-list">
                              {group.platformIds.length > 0
                                ? group.platformIds
                                    .slice(0, visiblePlatformIds)
                                    .map((platformId) => (
                                      <span
                                        className="platform-id"
                                        key={platformId}
                                        title={platformId}
                                      >
                                        {platformId}
                                      </span>
                                    ))
                                : '—'}
                              {overflowPlatformIds.length > 0 && (
                                <span
                                  className="platform-id platform-id--more"
                                  title={overflowPlatformIds.join(', ')}
                                >
                                  +{overflowPlatformIds.length}
                                </span>
                              )}
                            </div>
                          </td>
                          {/* Environment and region are one thought — where this
                              application runs — so they read as one cell. */}
                          <td className="col-scope">
                            <div className="scope-cell">
                              <div className="environment-list">
                                {group.environments.map((item) => (
                                  <span className="environment-tag" key={item}>
                                    {item}
                                  </span>
                                ))}
                              </div>
                              {/* One run of text rather than one element per
                                  region: a flex row of tags clipped mid-word,
                                  which reads as a rendering fault. */}
                              <span className="region-run" title={group.regions.join(', ')}>
                                {group.regions.length > 0 ? group.regions.join(' · ') : '—'}
                              </span>
                            </div>
                          </td>
                          <td className="col-delivery">
                            <span className="release-target-count">
                              {releaseCountLabel(group.records.length)}
                              <small>{targetCountLabel(group.targets.length)}</small>
                            </span>
                          </td>
                          <td className="col-recon">
                            <StateDelta
                              syncStatus={rollup.syncStatus}
                              healthStatus={rollup.healthStatus}
                            />
                          </td>
                          <td className="col-status">
                            <StatusBadge status={group.status} />
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr className="expanded-row" id={targetsRowId}>
                            <td colSpan={7}>
                              <div className="application-targets">
                                <div className="application-targets-heading">
                                  <code title={group.applicationId}>ID {group.applicationId}</code>
                                  <Link to={`/applications/${group.applicationId}`}>
                                    Open application →
                                  </Link>
                                </div>
                                <table
                                  className="application-target-table"
                                  aria-label={`Deployment targets for ${group.name}`}
                                >
                                  <thead>
                                    <tr>
                                      <th>Environment</th>
                                      <th>Region</th>
                                      <th>Namespace</th>
                                      <th>Cluster</th>
                                      <th>Reconciliation</th>
                                      <th>Status</th>
                                      <th>Argo</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {flattenTargets(group.records).map((row) => (
                                      <tr
                                        key={row.key}
                                        className={
                                          row.target
                                            ? toneClass[
                                                deltaTone(
                                                  row.target.syncStatus,
                                                  row.target.healthStatus,
                                                )
                                              ]
                                            : ''
                                        }
                                      >
                                        <td>
                                          <span className="environment-tag">{row.environment}</span>
                                        </td>
                                        <td className="mono-cell">{row.region || '—'}</td>
                                        <td className="mono-cell" title={row.namespace}>
                                          {row.namespace}
                                        </td>
                                        <td
                                          className="mono-cell"
                                          title={row.target?.clusterName ?? undefined}
                                        >
                                          {row.target?.clusterName ?? (
                                            <span className="quiet-note">No targets</span>
                                          )}
                                        </td>
                                        <td>
                                          {row.target ? (
                                            <StateDelta
                                              syncStatus={row.target.syncStatus}
                                              healthStatus={row.target.healthStatus}
                                            />
                                          ) : (
                                            '—'
                                          )}
                                        </td>
                                        <td>
                                          {row.target ? (
                                            <StatusBadge status={row.target.status} />
                                          ) : (
                                            '—'
                                          )}
                                        </td>
                                        <td>
                                          {row.target?.argoApplicationUrl ? (
                                            <a
                                              href={row.target.argoApplicationUrl}
                                              target="_blank"
                                              rel="noreferrer"
                                              title={row.target.argoApplication}
                                            >
                                              Open
                                            </a>
                                          ) : (
                                            <span
                                              className="revision-tag"
                                              title={row.target?.argoApplication}
                                            >
                                              {row.target?.argoApplication ?? '—'}
                                            </span>
                                          )}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
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
            {filteredGroups.length === 0
              ? 'No applications'
              : `Showing ${firstIndex + 1}–${Math.min(
                  firstIndex + pageSize,
                  filteredGroups.length,
                )} of ${filteredGroups.length} ${
                  filteredGroups.length === 1 ? 'application' : 'applications'
                }`}
          </span>
          <div className="pagination-controls">
            <label className="page-size-control">
              <span>Rows</span>
              <select
                aria-label="Applications per page"
                value={pageSize}
                onChange={(event) => updateParams({ pageSize: event.target.value })}
              >
                {pageSizeOptions.map((option) => (
                  <option value={option} key={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
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
