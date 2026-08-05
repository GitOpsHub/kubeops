import { useCallback, useEffect, useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import {
  type CloudSource,
  type Cluster,
  type Provider,
  type SyncRun,
  getClusters,
  getSources,
  getSyncRuns,
  queueSourceSync,
} from '../api/inventory'
import type { AppShellContext } from '../lib/app-shell'
import { KubernetesLogo, ProviderLogo } from './BrandIcons'
import { ClusterDetailDrawer } from './ClusterDetailDrawer'
import { StatusBadge } from './StatusBadge'

const pageSizes = [25, 50, 100]

const providerLabels: Record<Provider, string> = {
  aws: 'EKS',
  azure: 'AKS',
  gcp: 'GKE',
  docker: 'Docker',
  minikube: 'Minikube',
}

const providers: Provider[] = ['aws', 'azure', 'gcp', 'docker', 'minikube']

function relativeTime(value: string | null) {
  if (!value) return 'Never'
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000)
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  if (Math.abs(seconds) < 60) return formatter.format(seconds, 'second')
  const minutes = Math.round(seconds / 60)
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute')
  return formatter.format(Math.round(minutes / 60), 'hour')
}

function isStale(value: string | null) {
  return !value || Date.now() - new Date(value).getTime() > 11 * 60 * 1000
}

function clusterCountLabel(count: number) {
  return `${count} ${count === 1 ? 'cluster' : 'clusters'}`
}

export function FleetDashboard() {
  const { onLatestRunChange } = useOutletContext<AppShellContext>()
  const [sources, setSources] = useState<CloudSource[]>([])
  const [clusters, setClusters] = useState<Cluster[]>([])
  const [runs, setRuns] = useState<SyncRun[]>([])
  const [total, setTotal] = useState(0)
  const [provider, setProvider] = useState<Provider | ''>('')
  const [globalSearch, setGlobalSearch] = useState('')
  const [providerSearch, setProviderSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState('')
  const [selectedCluster, setSelectedCluster] = useState<Cluster | null>(null)

  const search = provider ? providerSearch : globalSearch

  const loadDashboard = useCallback(
    async (signal?: AbortSignal, quiet = false) => {
      if (!quiet) setLoading(true)
      try {
        const [clusterPage, nextSources, nextRuns] = await Promise.all([
          getClusters({ provider, search, page, pageSize }, signal),
          getSources(signal),
          getSyncRuns(signal),
        ])
        setClusters(clusterPage.items)
        setTotal(clusterPage.total)
        setSources(nextSources)
        setRuns(nextRuns)
        onLatestRunChange(nextRuns[0] ?? null)
        setError('')
      } catch (loadError) {
        if (!(loadError instanceof DOMException && loadError.name === 'AbortError')) {
          setError(loadError instanceof Error ? loadError.message : 'Inventory could not be loaded')
        }
      } finally {
        if (!quiet) setLoading(false)
      }
    },
    [onLatestRunChange, page, pageSize, provider, search],
  )

  useEffect(() => {
    const controller = new AbortController()
    void loadDashboard(controller.signal)
    const interval = window.setInterval(() => void loadDashboard(undefined, true), 30_000)
    return () => {
      controller.abort()
      window.clearInterval(interval)
    }
  }, [loadDashboard])

  const counts = useMemo(
    () =>
      providers.reduce<Record<Provider, number>>(
        (result, item) => {
          result[item] = sources
            .filter((entry) => entry.provider === item)
            .reduce((sum, entry) => sum + entry.clusterCount, 0)
          return result
        },
        { aws: 0, azure: 0, gcp: 0, docker: 0, minikube: 0 },
      ),
    [sources],
  )

  const fleetTotal = providers.reduce((sum, item) => sum + counts[item], 0)
  const activeSources = sources.filter((item) => item.enabled).length
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  // Sources that failed outright, or whose last success is old enough that the
  // inventory can no longer be trusted.
  const staleSources = sources.filter(
    (item) => item.enabled && (item.lastSyncStatus === 'failed' || isStale(item.lastSyncAt)),
  ).length
  async function refreshSource(item: CloudSource) {
    setRefreshing(item.id)
    try {
      await queueSourceSync(item.id)
      await loadDashboard(undefined, true)
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Sync could not be queued')
    } finally {
      setRefreshing('')
    }
  }

  function updateFilter(action: () => void) {
    action()
    setPage(1)
  }

  function selectProvider(nextProvider: Provider) {
    updateFilter(() => {
      setProvider(nextProvider)
      setProviderSearch('')
    })
  }

  function selectAllProviders() {
    updateFilter(() => {
      setProvider('')
      setProviderSearch('')
      setGlobalSearch('')
    })
  }

  function updateGlobalSearch(value: string) {
    updateFilter(() => {
      setGlobalSearch(value)
      setProvider('')
    })
  }

  return (
    <section className="fleet-page" aria-labelledby="fleet-heading">
      <header className="page-heading fleet-heading">
        <div>
          <h1 id="fleet-heading">Fleet control center</h1>
          <p>Every cluster your connected cloud sources have discovered.</p>
        </div>
        <div className="fleet-stats">
          <div
            className="fleet-metric"
            aria-label={`${fleetTotal} clusters across ${activeSources} sources`}
          >
            <span>Fleet size</span>
            <strong>{fleetTotal}</strong>
            <small>{activeSources} active sources</small>
          </div>
          <div className="fleet-metric">
            <span>In this view</span>
            <strong>{total}</strong>
            <small>{provider ? providerLabels[provider] : 'all providers'}</small>
          </div>
          <div className="fleet-metric">
            <span>Needs a look</span>
            <strong>{staleSources}</strong>
            <small>{staleSources === 1 ? 'source behind' : 'sources behind'}</small>
          </div>
        </div>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          <div>
            <strong>Inventory update failed</strong>
            <span>{error}</span>
          </div>
          <button type="button" className="text-button" onClick={() => void loadDashboard()}>
            Try again
          </button>
        </div>
      )}

      <section className="provider-console" aria-labelledby="provider-filter-heading">
        <h2 id="provider-filter-heading" className="sr-only">Filter by provider</h2>

        <div className="provider-selector" role="group" aria-label="Filter by cloud provider">
          <button
            type="button"
            className={`provider-button provider-button--all ${
              provider === '' ? 'is-selected' : ''
            }`}
            onClick={selectAllProviders}
            aria-pressed={provider === ''}
            aria-label={`All, ${clusterCountLabel(fleetTotal)}`}
          >
            <KubernetesLogo className="provider-logo" />
            <strong>All</strong>
            <small>{fleetTotal}</small>
          </button>
          {providers.map((item) => (
            <button
              type="button"
              className={`provider-button provider-button--${item} ${
                provider === item ? 'is-selected' : ''
              }`}
              key={item}
              onClick={() => selectProvider(item)}
              aria-pressed={provider === item}
              aria-label={`${providerLabels[item]}, ${clusterCountLabel(counts[item])}`}
            >
              <ProviderLogo provider={item} className="provider-logo" />
              <strong>{providerLabels[item]}</strong>
              <small>{counts[item]}</small>
            </button>
          ))}
        </div>

        {provider && (
          <div className="provider-search-row">
            <label className="provider-search">
              <span className="search-icon" aria-hidden="true">⌕</span>
              <span className="sr-only">Search within {providerLabels[provider]}</span>
              <input
                aria-label={`Search within ${providerLabels[provider]}`}
                autoFocus
                type="search"
                placeholder={`Search ${providerLabels[provider]} clusters`}
                value={providerSearch}
                onChange={(event) =>
                  updateFilter(() => setProviderSearch(event.target.value))
                }
              />
            </label>
            <span>
              Searching within <strong>{providerLabels[provider]}</strong>
            </span>
          </div>
        )}
      </section>

      <section className="inventory-section" aria-labelledby="inventory-heading">
        <div className="section-heading">
          <div>
            <p className="section-label">Live inventory</p>
            <h2 id="inventory-heading">
              {provider ? providerLabels[provider] : 'All providers'}
              <span>{total} results</span>
            </h2>
          </div>
          <span className="quiet-note">Refreshes every 30 seconds</span>
        </div>

        <div className="filter-bar inventory-filter-bar">
          <label className="filter-control inventory-search-control">
            <span>Cluster name</span>
            <span className="inventory-search">
              <span className="search-icon" aria-hidden="true">⌕</span>
              <input
                aria-label="Search all clusters across providers"
                type="search"
                placeholder="Search clusters"
                value={globalSearch}
                onChange={(event) => updateGlobalSearch(event.target.value)}
              />
            </span>
          </label>
          {search && (
            <div className="active-filter-row">
              {/* Active filters are restated as chips so each one can be dropped
                  on its own, rather than only all at once. */}
              <div className="filter-chips">
                {search && (
                  <span className="chip">
                    Name <strong>{search}</strong>
                    <button
                      type="button"
                      className="chip-remove"
                      aria-label={`Remove name filter ${search}`}
                      onClick={() =>
                        updateFilter(() => {
                          setGlobalSearch('')
                          setProviderSearch('')
                        })
                      }
                    >
                      ×
                    </button>
                  </span>
                )}
              </div>
              <button
                type="button"
                className="clear-filters"
                onClick={() =>
                  updateFilter(() => {
                    setGlobalSearch('')
                    setProviderSearch('')
                  })
                }
              >
                Clear filters
              </button>
            </div>
          )}
        </div>

        <div className="table-frame">
          {loading ? (
            <div className="table-state" role="status">
              <span className="loader" aria-hidden="true" />
              Loading cluster inventory…
            </div>
          ) : clusters.length === 0 ? (
            <div className="table-state">
              <KubernetesLogo className="empty-kubernetes-logo" />
              {search || provider ? (
                <>
                  <strong>Nothing matches those filters</strong>
                  <span>Try a different search, or clear the filters to see every cluster.</span>
                </>
              ) : (
                <>
                  <strong>No clusters discovered yet</strong>
                  <span>Sync an enabled provider source to pull your clusters in.</span>
                </>
              )}
            </div>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th className="col-cluster">Cluster</th>
                    <th className="col-provider">Provider</th>
                    <th className="col-location">Location</th>
                    <th className="col-nodes">Nodes</th>
                    <th className="col-health">Health</th>
                    <th className="col-seen">Last seen</th>
                    <th className="col-actions" aria-label="Row actions" />
                  </tr>
                </thead>
                <tbody>
                  {clusters.map((cluster) => (
                    <tr
                      key={cluster.id}
                      className={`row-clickable ${cluster.removedAt ? 'removed-row' : ''}`}
                      onClick={() => setSelectedCluster(cluster)}
                    >
                      {/* Endpoint access rides with the source name: it qualifies
                          how you reach this cluster, and it never earned a column
                          of its own for a one-word value. */}
                      <td className="col-cluster">
                        <button
                          type="button"
                          className="cluster-name"
                          onClick={() => setSelectedCluster(cluster)}
                        >
                          <span className="cluster-logo-stack">
                            <KubernetesLogo className="kubernetes-logo" />
                            <ProviderLogo
                              provider={cluster.provider}
                              className="provider-logo provider-logo--badge"
                            />
                          </span>
                          <span>
                            <strong title={cluster.name}>{cluster.name}</strong>
                            <small title={cluster.sourceName}>
                              {cluster.sourceName}
                              <i className="endpoint-tag">{cluster.endpointAccess}</i>
                            </small>
                          </span>
                        </button>
                      </td>
                      <td className="col-provider">
                        <span className="provider-cell">
                          <ProviderLogo provider={cluster.provider} className="provider-logo" />
                          {providerLabels[cluster.provider]}
                        </span>
                      </td>
                      {/* Location and version are both "which cluster is this",
                          and the version string is long enough that a column of
                          its own squeezed every neighbour. */}
                      <td className="col-location">
                        <span className="location-cell">
                          <span className="mono">{cluster.location}</span>
                          <small
                            className="mono"
                            title={cluster.kubernetesVersion || undefined}
                          >
                            {cluster.kubernetesVersion || '—'}
                          </small>
                        </span>
                      </td>
                      <td className="col-nodes numeric">{cluster.nodeCount ?? '—'}</td>
                      <td className="col-health">
                        <StatusBadge
                          status={cluster.removedAt ? 'removed' : 'active'}
                          tone={cluster.removedAt ? 'idle' : undefined}
                        />
                      </td>
                      <td
                        className={`col-seen ${isStale(cluster.lastSeenAt) ? 'stale' : ''}`}
                      >
                        {relativeTime(cluster.lastSeenAt)}
                      </td>
                      <td className="col-actions actions-cell">
                        <button
                          type="button"
                          className="refresh-button"
                          aria-label={`Open details for ${cluster.name}`}
                          onClick={() => setSelectedCluster(cluster)}
                        >
                          Details
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="pagination">
            <span>
              Page {page} of {totalPages} · {total} clusters
            </span>
            <div className="pagination-controls">
              <label>
                <span>Rows</span>
                <select
                  aria-label="Clusters per page"
                  value={pageSize}
                  onChange={(event) =>
                    updateFilter(() => setPageSize(Number(event.target.value)))
                  }
                >
                  {pageSizes.map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={page === 1}
                onClick={() => setPage((current) => current - 1)}
              >
                Previous
              </button>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => setPage((current) => current + 1)}
              >
                Next
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="lower-grid">
        <div id="sources">
          <div className="section-heading section-heading--compact">
            <div>
              <p className="section-label">Connections</p>
              <h2>Cloud sources</h2>
            </div>
          </div>
          <div className="source-list">
            {sources.length === 0 ? (
              <div className="empty-panel">
                Add a source to <code>config/cloud-sources.yaml</code> to begin discovery.
              </div>
            ) : (
              sources.map((item) => (
                <article className="source-row" key={item.id}>
                  <span className="source-logo">
                    <ProviderLogo provider={item.provider} className="provider-logo" />
                  </span>
                  <div className="source-copy">
                    <strong>{item.name}</strong>
                    <span>{item.scopeId} · {item.clusterCount} clusters</span>
                  </div>
                  <div className="source-state">
                    <StatusBadge
                      status={
                        isStale(item.lastSyncAt) && item.lastSyncStatus === 'succeeded'
                          ? 'stale'
                          : item.lastSyncStatus
                      }
                    />
                    <small>{relativeTime(item.lastSyncAt)}</small>
                  </div>
                  <button
                    type="button"
                    className="refresh-button"
                    onClick={() => void refreshSource(item)}
                    disabled={!item.enabled || refreshing === item.id}
                  >
                    {refreshing === item.id ? 'Queueing…' : 'Sync now'}
                  </button>
                </article>
              ))
            )}
          </div>
        </div>

        <div id="activity">
          <div className="section-heading section-heading--compact">
            <div>
              <p className="section-label">Reconciliation</p>
              <h2>Recent syncs</h2>
            </div>
          </div>
          <div className="activity-list">
            {runs.length === 0 ? (
              <div className="empty-panel">Sync activity will appear here.</div>
            ) : (
              runs.slice(0, 6).map((run) => (
                <article className="activity-row" key={run.id}>
                  <span className={`sync-dot sync-dot--${run.status}`} />
                  <div>
                    <strong>{run.sourceName}</strong>
                    <span>{run.trigger} · {run.discoveredCount} discovered</span>
                  </div>
                  <time dateTime={run.queuedAt}>{relativeTime(run.queuedAt)}</time>
                </article>
              ))
            )}
          </div>
        </div>
      </section>

      {selectedCluster && (
        <ClusterDetailDrawer
          cluster={selectedCluster}
          onClose={() => setSelectedCluster(null)}
        />
      )}
    </section>
  )
}
