import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  type CloudSource,
  type Cluster,
  type Provider,
  type SyncRun,
  getClusters,
  getSources,
  getSyncRuns,
  queueSourceSync,
} from './api/inventory'
import { KubernetesLogo, ProviderLogo } from './components/BrandIcons'
import { ClusterDetailDrawer } from './components/ClusterDetailDrawer'
import { ApplicationOnboarding } from './components/ApplicationOnboarding'

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

function App() {
  const [sources, setSources] = useState<CloudSource[]>([])
  const [clusters, setClusters] = useState<Cluster[]>([])
  const [runs, setRuns] = useState<SyncRun[]>([])
  const [total, setTotal] = useState(0)
  const [provider, setProvider] = useState<Provider | ''>('')
  const [source, setSource] = useState('')
  const [globalSearch, setGlobalSearch] = useState('')
  const [providerSearch, setProviderSearch] = useState('')
  const [includeRemoved, setIncludeRemoved] = useState(false)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState('')
  const [selectedCluster, setSelectedCluster] = useState<Cluster | null>(null)
  const [showOnboarding, setShowOnboarding] = useState(false)

  const search = provider ? providerSearch : globalSearch

  const loadDashboard = useCallback(
    async (signal?: AbortSignal, quiet = false) => {
      if (!quiet) setLoading(true)
      try {
        const [clusterPage, nextSources, nextRuns] = await Promise.all([
          getClusters(
            { provider, source, search, includeRemoved, page, pageSize: 25 },
            signal,
          ),
          getSources(signal),
          getSyncRuns(signal),
        ])
        setClusters(clusterPage.items)
        setTotal(clusterPage.total)
        setSources(nextSources)
        setRuns(nextRuns)
        setError('')
      } catch (loadError) {
        if (!(loadError instanceof DOMException && loadError.name === 'AbortError')) {
          setError(loadError instanceof Error ? loadError.message : 'Inventory could not be loaded')
        }
      } finally {
        if (!quiet) setLoading(false)
      }
    },
    [includeRemoved, page, provider, search, source],
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
  const availableSources = provider
    ? sources.filter((item) => item.provider === provider)
    : sources
  const totalPages = Math.max(1, Math.ceil(total / 25))
  const latestRun = runs[0]

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

  function selectProvider(nextProvider: Provider | '') {
    updateFilter(() => {
      setProvider(nextProvider)
      setSource('')
    })
  }

  function updateGlobalSearch(value: string) {
    updateFilter(() => {
      setGlobalSearch(value)
      setProvider('')
      setSource('')
    })
  }

  return (
    <div className="app-shell">
      <main className="dashboard" id="inventory">
        <header className="topbar">
          <a className="header-brand" href="/" aria-label="KubeOps home">
            <KubernetesLogo className="brand-mark" />
            <strong>KubeOps</strong>
          </a>
          <label className="global-search">
            <span className="search-icon" aria-hidden="true">⌕</span>
            <span className="sr-only">Search all clusters across providers</span>
            <input
              aria-label="Search all clusters across providers"
              type="search"
              placeholder="Search cluster names across all providers"
              value={globalSearch}
              onChange={(event) => updateGlobalSearch(event.target.value)}
            />
            <kbd>Global</kbd>
          </label>
          <div className="sync-readout">
            <span className={`sync-dot sync-dot--${latestRun?.status || 'idle'}`} />
            <div>
              <strong>{latestRun ? `Sync ${latestRun.status}` : 'Awaiting sync'}</strong>
              <span>{latestRun ? relativeTime(latestRun.queuedAt) : 'No activity yet'}</span>
            </div>
          </div>
        </header>

        <div className="dashboard-content">
          {showOnboarding ? (
            <ApplicationOnboarding onBack={() => setShowOnboarding(false)} />
          ) : (
          <>
          <header className="page-heading">
            <div>
              <p className="kicker">Kubernetes estate</p>
              <h1>Fleet control center</h1>
              <p>Search, filter, and reconcile every managed and local cluster from one view.</p>
            </div>
            <div className="heading-actions">
              <button
                type="button"
                className="primary-button"
                onClick={() => setShowOnboarding(true)}
              >
                Onboard application
              </button>
              <div className="fleet-metric" aria-label={`${fleetTotal} clusters across ${activeSources} sources`}>
                <span>Fleet size</span>
                <strong>{fleetTotal}</strong>
                <small>{activeSources} active sources</small>
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
                className={`provider-button provider-button--all ${!provider ? 'is-selected' : ''}`}
                onClick={() => selectProvider('')}
                aria-pressed={!provider}
                aria-label={`All clouds, ${clusterCountLabel(fleetTotal)}`}
              >
                <span className="all-clouds-icon" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span>
                  <strong>All clouds</strong>
                  <small>{fleetTotal}</small>
                </span>
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
                  <span>
                    <strong>{providerLabels[item]}</strong>
                    <small>{counts[item]}</small>
                  </span>
                  <span className="selection-check" aria-hidden="true">✓</span>
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

            <div className="filter-toolbar">
              <label>
                <span>Source</span>
                <select
                  value={source}
                  onChange={(event) => updateFilter(() => setSource(event.target.value))}
                >
                  <option value="">All {provider ? providerLabels[provider] : ''} sources</option>
                  {availableSources.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={includeRemoved}
                  onChange={(event) =>
                    updateFilter(() => setIncludeRemoved(event.target.checked))
                  }
                />
                <span aria-hidden="true" />
                Include removed clusters
              </label>
              {(search || source || includeRemoved) && (
                <button
                  type="button"
                  className="clear-filters"
                  onClick={() =>
                    updateFilter(() => {
                      setGlobalSearch('')
                      setProviderSearch('')
                      setSource('')
                      setIncludeRemoved(false)
                    })
                  }
                >
                  Clear filters
                </button>
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
                  <strong>No clusters match this view</strong>
                  <span>Clear the search or sync an enabled provider source.</span>
                </div>
              ) : (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Cluster</th>
                        <th>Cloud provider</th>
                        <th>Location</th>
                        <th>Version</th>
                        <th>Health</th>
                        <th>Endpoint</th>
                        <th>Nodes</th>
                        <th>Last seen</th>
                      </tr>
                    </thead>
                    <tbody>
                      {clusters.map((cluster) => (
                        <tr
                          key={cluster.id}
                          className={cluster.removedAt ? 'removed-row' : ''}
                          onClick={() => setSelectedCluster(cluster)}
                        >
                          <td>
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
                                <strong>{cluster.name}</strong>
                                <small>{cluster.sourceName}</small>
                              </span>
                            </button>
                          </td>
                          <td>
                            <span className="provider-cell">
                              <ProviderLogo provider={cluster.provider} className="provider-logo" />
                              {providerLabels[cluster.provider]}
                            </span>
                          </td>
                          <td className="mono">{cluster.location}</td>
                          <td className="mono">{cluster.kubernetesVersion || '—'}</td>
                          <td>
                            <span className={`status-pill status-pill--${cluster.status}`}>
                              {cluster.removedAt ? 'removed' : cluster.status}
                            </span>
                          </td>
                          <td className="capitalize">{cluster.endpointAccess}</td>
                          <td>{cluster.nodeCount ?? '—'}</td>
                          <td className={isStale(cluster.lastSeenAt) ? 'stale' : ''}>
                            {relativeTime(cluster.lastSeenAt)}
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
                <div>
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
                        <span className={`source-status source-status--${item.lastSyncStatus}`}>
                          {isStale(item.lastSyncAt) && item.lastSyncStatus === 'succeeded'
                            ? 'stale'
                            : item.lastSyncStatus}
                        </span>
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
          </>
          )}
        </div>
      </main>

      {selectedCluster && (
        <ClusterDetailDrawer
          cluster={selectedCluster}
          onClose={() => setSelectedCluster(null)}
        />
      )}
    </div>
  )
}

export default App
