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

const providerLabels: Record<Provider, string> = {
  aws: 'AWS',
  gcp: 'Google Cloud',
  azure: 'Azure',
  docker: 'Docker',
  minikube: 'Minikube',
}

const providers: Provider[] = ['aws', 'gcp', 'azure', 'docker', 'minikube']

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

function App() {
  const [sources, setSources] = useState<CloudSource[]>([])
  const [clusters, setClusters] = useState<Cluster[]>([])
  const [runs, setRuns] = useState<SyncRun[]>([])
  const [total, setTotal] = useState(0)
  const [provider, setProvider] = useState<Provider | ''>('')
  const [source, setSource] = useState('')
  const [search, setSearch] = useState('')
  const [includeRemoved, setIncludeRemoved] = useState(false)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState('')
  const [selectedCluster, setSelectedCluster] = useState<Cluster | null>(null)

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
        { aws: 0, gcp: 0, azure: 0, docker: 0, minikube: 0 },
      ),
    [sources],
  )

  const fleetTotal = counts.aws + counts.gcp + counts.azure
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

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="KubeOps home">
          <span className="brand-mark" aria-hidden="true">
            K
          </span>
          <span>KubeOps</span>
        </a>
        <nav aria-label="Primary navigation">
          <a className="nav-item nav-item--active" href="#inventory">
            <span aria-hidden="true">⌁</span> Fleet inventory
          </a>
          <a className="nav-item" href="#sources">
            <span aria-hidden="true">◎</span> Cloud sources
          </a>
          <a className="nav-item" href="#activity">
            <span aria-hidden="true">↻</span> Sync activity
          </a>
        </nav>
        <div className="sidebar-foot">
          <span className="pulse" aria-hidden="true" />
          Polling every 5 minutes
        </div>
      </aside>

      <main className="dashboard" id="inventory">
        <header className="dashboard-header">
          <div>
            <p className="kicker">Multi-cloud Kubernetes inventory</p>
            <h1>Fleet atlas</h1>
          </div>
          <div className="sync-readout">
            <span className={`sync-dot sync-dot--${latestRun?.status || 'idle'}`} />
            <div>
              <strong>{latestRun ? `Latest sync ${latestRun.status}` : 'Waiting for first sync'}</strong>
              <span>{latestRun ? relativeTime(latestRun.queuedAt) : 'Cloud sources are idle'}</span>
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

        <section className="fleet-rail" aria-label="Fleet summary">
          <div className="fleet-total">
            <span>Managed clusters</span>
            <strong>{fleetTotal}</strong>
            <small>across {sources.filter((item) => item.enabled).length} active sources</small>
          </div>
          <div className="provider-track">
            <div className="track-bars" aria-hidden="true">
              {providers.map((item) => (
                <span
                  key={item}
                  className={`track-bar track-bar--${item}`}
                  style={{
                    flexGrow: fleetTotal ? Math.max(counts[item], fleetTotal * 0.04) : 1,
                  }}
                />
              ))}
            </div>
            <div className="provider-stats">
              {providers.map((item) => (
                <button
                  type="button"
                  className={`provider-stat provider-stat--${item} ${
                    provider === item ? 'provider-stat--selected' : ''
                  }`}
                  key={item}
                  onClick={() => updateFilter(() => setProvider(provider === item ? '' : item))}
                  aria-pressed={provider === item}
                >
                  <span>{providerLabels[item]}</span>
                  <strong>{counts[item]}</strong>
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="inventory-section" aria-labelledby="inventory-heading">
          <div className="section-heading">
            <div>
              <p className="section-label">Live inventory</p>
              <h2 id="inventory-heading">{total} clusters in view</h2>
            </div>
            <span className="quiet-note">Auto-refreshes every 30 seconds</span>
          </div>

          <div className="filters">
            <label className="search-field">
              <span className="sr-only">Search clusters</span>
              <span aria-hidden="true">⌕</span>
              <input
                type="search"
                placeholder="Search cluster name"
                value={search}
                onChange={(event) => updateFilter(() => setSearch(event.target.value))}
              />
            </label>
            <label>
              <span className="sr-only">Cloud provider</span>
              <select
                value={provider}
                onChange={(event) =>
                  updateFilter(() => setProvider(event.target.value as Provider | ''))
                }
              >
                <option value="">All providers</option>
                <option value="aws">AWS</option>
                <option value="gcp">Google Cloud</option>
                <option value="azure">Azure</option>
                <option value="docker">Docker</option>
                <option value="minikube">Minikube</option>
              </select>
            </label>
            <label>
              <span className="sr-only">Cloud source</span>
              <select
                value={source}
                onChange={(event) => updateFilter(() => setSource(event.target.value))}
              >
                <option value="">All sources</option>
                {sources.map((item) => (
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
              Show removed
            </label>
          </div>

          <div className="table-frame">
            {loading ? (
              <div className="table-state" role="status">
                <span className="loader" aria-hidden="true" />
                Mapping the fleet…
              </div>
            ) : clusters.length === 0 ? (
              <div className="table-state">
                <strong>No clusters match this view</strong>
                <span>Adjust the filters or sync an enabled cloud source.</span>
              </div>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Cluster</th>
                      <th>Provider</th>
                      <th>Location</th>
                      <th>Version</th>
                      <th>Status</th>
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
                            <span className={`provider-glyph provider-glyph--${cluster.provider}`}>
                              {cluster.provider.slice(0, 1).toUpperCase()}
                            </span>
                            <span>
                              <strong>{cluster.name}</strong>
                              <small>{cluster.sourceName}</small>
                            </span>
                          </button>
                        </td>
                        <td>{providerLabels[cluster.provider]}</td>
                        <td className="mono">{cluster.location}</td>
                        <td className="mono">{cluster.kubernetesVersion || '—'}</td>
                        <td>
                          <span className={`status-pill status-pill--${cluster.status}`}>
                            {cluster.removedAt ? 'removed' : cluster.status}
                          </span>
                        </td>
                        <td>{cluster.endpointAccess}</td>
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
                Page {page} of {totalPages}
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
                    <span className={`provider-glyph provider-glyph--${item.provider}`}>
                      {item.provider.slice(0, 1).toUpperCase()}
                    </span>
                    <div className="source-copy">
                      <strong>{item.name}</strong>
                      <span>
                        {item.scopeId} · {item.clusterCount} clusters
                      </span>
                    </div>
                    <div className="source-state">
                      <span
                        className={`source-status source-status--${item.lastSyncStatus}`}
                      >
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
                      <span>
                        {run.trigger} · {run.discoveredCount} discovered
                      </span>
                    </div>
                    <time dateTime={run.queuedAt}>{relativeTime(run.queuedAt)}</time>
                  </article>
                ))
              )}
            </div>
          </div>
        </section>
      </main>

      {selectedCluster && (
        <div className="drawer-backdrop" role="presentation" onClick={() => setSelectedCluster(null)}>
          <aside
            className="detail-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cluster-detail-title"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="drawer-close"
              type="button"
              onClick={() => setSelectedCluster(null)}
              aria-label="Close cluster details"
            >
              ×
            </button>
            <p className="section-label">{providerLabels[selectedCluster.provider]}</p>
            <h2 id="cluster-detail-title">{selectedCluster.name}</h2>
            <p className="drawer-source">
              {selectedCluster.sourceName} · {selectedCluster.location}
            </p>
            <dl>
              <div>
                <dt>Status</dt>
                <dd>{selectedCluster.removedAt ? 'removed' : selectedCluster.status}</dd>
              </div>
              <div>
                <dt>Kubernetes</dt>
                <dd>{selectedCluster.kubernetesVersion || 'Unknown'}</dd>
              </div>
              <div>
                <dt>Endpoint</dt>
                <dd>{selectedCluster.endpointAccess}</dd>
              </div>
              <div>
                <dt>Nodes</dt>
                <dd>{selectedCluster.nodeCount ?? 'Not reported'}</dd>
              </div>
              <div>
                <dt>First seen</dt>
                <dd>{new Date(selectedCluster.firstSeenAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt>Last seen</dt>
                <dd>{new Date(selectedCluster.lastSeenAt).toLocaleString()}</dd>
              </div>
            </dl>
            <div className="resource-id">
              <span>Provider resource ID</span>
              <code>{selectedCluster.providerResourceId}</code>
            </div>
            <div className="metadata">
              <span>Provider metadata</span>
              <pre>{JSON.stringify(selectedCluster.metadata, null, 2)}</pre>
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}

export default App
