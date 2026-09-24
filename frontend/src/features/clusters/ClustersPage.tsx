import { useCallback, useMemo, useState } from 'react'
import { getClusters, getSources, type Cluster, type Provider } from '../../api/inventory'
import { KubernetesLogo, ProviderLogo } from '../../components/BrandIcons'
import { Banner } from '../../components/ui/Banner'
import { StatusBadge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { DataTable, type Column } from '../../components/ui/DataTable'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageHeader } from '../../components/ui/PageHeader'
import { Pagination } from '../../components/ui/Pagination'
import { RefreshIndicator } from '../../components/ui/RefreshIndicator'
import { SearchInput } from '../../components/ui/SearchInput'
import { SegmentedControl } from '../../components/ui/SegmentedControl'
import { SkeletonRows } from '../../components/ui/Skeleton'
import { StatCard } from '../../components/ui/StatCard'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import { usePolledResource } from '../../hooks/usePolledResource'
import { isOlderThan, plural, relativeTime } from '../../lib/format'
import { emptyProviderCounts, providerLabels, providers, staleAfterMs } from '../../lib/providers'
import { ClusterDetailDrawer } from './ClusterDetailDrawer'
import './clusters.css'

const pageSizes = [25, 50, 100]
const pollIntervalMs = 30_000
const searchDebounceMs = 250

type ProviderFilter = Provider | 'all'

export function ClustersPage() {
  const [provider, setProvider] = useState<ProviderFilter>('all')
  const [globalSearch, setGlobalSearch] = useState('')
  const [providerSearch, setProviderSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [selectedCluster, setSelectedCluster] = useState<Cluster | null>(null)

  // Two searches, deliberately: the global box always spans every provider,
  // while the scoped box searches only inside the provider just picked.
  const searchInput = provider === 'all' ? globalSearch : providerSearch
  const search = useDebouncedValue(searchInput, searchDebounceMs)
  const providerParam = provider === 'all' ? '' : provider

  const load = useCallback(
    async (signal: AbortSignal) => {
      const [clusterPage, sources] = await Promise.all([
        getClusters({ provider: providerParam, search, page, pageSize }, signal),
        getSources(signal),
      ])
      return { clusterPage, sources }
    },
    [page, pageSize, providerParam, search],
  )
  const inventory = usePolledResource(load, { intervalMs: pollIntervalMs })
  const sources = useMemo(() => inventory.data?.sources ?? [], [inventory.data])
  const clusters = inventory.data?.clusterPage.items ?? []
  const total = inventory.data?.clusterPage.total ?? 0

  const counts = useMemo(() => {
    const result = emptyProviderCounts()
    for (const source of sources) result[source.provider] += source.clusterCount
    return result
  }, [sources])

  const fleetTotal = providers.reduce((sum, item) => sum + counts[item], 0)
  const activeSources = sources.filter((item) => item.enabled).length
  // Sources that failed outright, or whose last success is old enough that the
  // inventory can no longer be trusted.
  const staleSources = sources.filter(
    (item) =>
      item.enabled &&
      (item.lastSyncStatus === 'failed' || isOlderThan(item.lastSyncAt, staleAfterMs)),
  ).length

  function updateFilter(action: () => void) {
    action()
    setPage(1)
  }

  function selectProvider(next: ProviderFilter) {
    updateFilter(() => {
      setProvider(next)
      setProviderSearch('')
      if (next === 'all') setGlobalSearch('')
    })
  }

  function clearSearch() {
    updateFilter(() => {
      setGlobalSearch('')
      setProviderSearch('')
    })
  }

  const columns: Column<Cluster>[] = [
    {
      id: 'cluster',
      header: 'Cluster',
      className: 'col-cluster',
      cell: (cluster) => (
        // Endpoint access rides with the source name: it qualifies how you
        // reach this cluster and never earned a column for a one-word value.
        <button
          type="button"
          className="cluster-name"
          onClick={(event) => {
            event.stopPropagation()
            setSelectedCluster(cluster)
          }}
        >
          <span className="cluster-logo-stack" aria-hidden="true">
            <KubernetesLogo className="cluster-logo" />
            <ProviderLogo provider={cluster.provider} className="cluster-logo-badge" />
          </span>
          <span className="cell-stack">
            <strong className="truncate" title={cluster.name}>
              {cluster.name}
            </strong>
            <small className="truncate" title={cluster.sourceName}>
              {cluster.sourceName} <span className="endpoint-tag">{cluster.endpointAccess}</span>
            </small>
          </span>
        </button>
      ),
    },
    {
      id: 'provider',
      header: 'Provider',
      cell: (cluster) => (
        <span className="provider-cell">
          <ProviderLogo provider={cluster.provider} className="provider-cell-logo" />
          {providerLabels[cluster.provider]}
        </span>
      ),
    },
    {
      id: 'location',
      header: 'Location',
      cell: (cluster) => (
        <span className="cell-stack">
          <span className="mono">{cluster.location}</span>
          <small className="mono" title={cluster.kubernetesVersion || undefined}>
            {cluster.kubernetesVersion || '—'}
          </small>
        </span>
      ),
    },
    {
      id: 'nodes',
      header: 'Nodes',
      align: 'end',
      className: 'cell-numeric',
      cell: (cluster) => cluster.nodeCount ?? '—',
    },
    {
      id: 'health',
      header: 'Health',
      cell: (cluster) => (
        <StatusBadge domain="cluster" status={cluster.removedAt ? 'removed' : 'active'} />
      ),
    },
    {
      id: 'seen',
      header: 'Last seen',
      cell: (cluster) => (
        <span
          className={isOlderThan(cluster.lastSeenAt, staleAfterMs) ? 'seen-stale' : 'cell-muted'}
        >
          {relativeTime(cluster.lastSeenAt)}
        </span>
      ),
    },
  ]

  const providerOptions = [
    {
      value: 'all' as const,
      label: (
        <>
          All <span className="segment-count">{fleetTotal}</span>
        </>
      ),
      icon: <KubernetesLogo />,
      ariaLabel: `All, ${plural(fleetTotal, 'cluster')}`,
    },
    ...providers.map((item) => ({
      value: item,
      label: (
        <>
          {providerLabels[item]} <span className="segment-count">{counts[item]}</span>
        </>
      ),
      icon: <ProviderLogo provider={item} />,
      ariaLabel: `${providerLabels[item]}, ${plural(counts[item], 'cluster')}`,
    })),
  ]

  return (
    <section className="page" aria-labelledby="clusters-heading">
      <PageHeader
        id="clusters-heading"
        title="Clusters"
        description="Every cluster your connected cloud sources have discovered."
        meta={
          <RefreshIndicator
            lastUpdated={inventory.lastUpdated}
            refreshing={inventory.refreshing}
            failed={Boolean(inventory.error)}
          />
        }
      />

      <div className="cluster-stats">
        <StatCard
          label="Fleet size"
          value={fleetTotal}
          hint={plural(activeSources, 'active source')}
          aria-label={`${fleetTotal} clusters across ${activeSources} sources`}
        />
        <StatCard
          label="In this view"
          value={total}
          hint={provider === 'all' ? 'all providers' : providerLabels[provider]}
        />
        <StatCard
          label="Sources behind"
          value={staleSources}
          tone={staleSources > 0 ? 'warn' : undefined}
          hint={staleSources > 0 ? 'failed or not synced recently' : 'all sources current'}
          to="/sources"
        />
      </div>

      {inventory.error && (
        <Banner
          tone="error"
          title="Inventory update failed"
          onRetry={() => void inventory.reload()}
        >
          {inventory.error.message}
        </Banner>
      )}

      <div className="panel">
        <div className="panel-toolbar">
          <SegmentedControl
            label="Filter by cloud provider"
            options={providerOptions}
            value={provider}
            onChange={selectProvider}
            className="provider-filter"
          />
          <div className="panel-toolbar-search">
            {/* The global box keeps its position in the tree whichever provider
                is picked, so typing into it survives the switch back to All. */}
            {provider !== 'all' && (
              <SearchInput
                label={`Search within ${providerLabels[provider]}`}
                placeholder={`Search ${providerLabels[provider]} clusters`}
                value={providerSearch}
                autoFocus
                onChange={(value) => updateFilter(() => setProviderSearch(value))}
              />
            )}
            <SearchInput
              label="Search all clusters across providers"
              placeholder={provider === 'all' ? 'Search clusters' : 'Search every provider'}
              value={globalSearch}
              onChange={(value) =>
                updateFilter(() => {
                  setGlobalSearch(value)
                  setProvider('all')
                  setProviderSearch('')
                })
              }
              className={provider === 'all' ? undefined : 'cluster-global-search'}
            />
          </div>
        </div>

        <div className="panel-subheader">
          <h2>
            {provider === 'all' ? 'All providers' : providerLabels[provider]}
            <span>{plural(total, 'result')}</span>
          </h2>
          {searchInput && (
            <span className="chip">
              Name <strong>{searchInput}</strong>
              <button
                type="button"
                className="chip-remove"
                aria-label={`Remove name filter ${searchInput}`}
                onClick={clearSearch}
              >
                ×
              </button>
            </span>
          )}
        </div>

        <div aria-busy={inventory.loading || inventory.refreshing}>
          {inventory.loading ? (
            <div role="status">
              <span className="sr-only">Loading cluster inventory…</span>
              <SkeletonRows rows={6} columns={6} />
            </div>
          ) : clusters.length === 0 ? (
            <EmptyState
              icon={<KubernetesLogo />}
              title={
                searchInput || provider !== 'all'
                  ? 'Nothing matches those filters'
                  : inventory.error
                    ? 'Cluster inventory is unavailable'
                    : 'No clusters discovered yet'
              }
              description={
                searchInput || provider !== 'all'
                  ? 'Try a different search, or clear the filters to see every cluster.'
                  : 'Sync an enabled cloud source to pull your clusters in.'
              }
              action={
                searchInput || provider !== 'all' ? (
                  <Button size="sm" onClick={() => selectProvider('all')}>
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <DataTable
              label="Clusters"
              columns={columns}
              rows={clusters}
              rowKey={(cluster) => cluster.id}
              onRowClick={setSelectedCluster}
              focusableRows={false}
              rowClassName={(cluster) => (cluster.removedAt ? 'is-removed' : '')}
            />
          )}
        </div>

        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          pageSizeOptions={pageSizes}
          onPageChange={setPage}
          onPageSizeChange={(size) => updateFilter(() => setPageSize(size))}
          noun={['cluster', 'clusters']}
          pageSizeLabel="Clusters per page"
          label="Clusters pagination"
        />
      </div>

      {selectedCluster && (
        <ClusterDetailDrawer cluster={selectedCluster} onClose={() => setSelectedCluster(null)} />
      )}
    </section>
  )
}
