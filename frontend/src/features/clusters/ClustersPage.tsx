import { useCallback, useEffect, useMemo, useState } from 'react'
import { getClusters, getSources, type Cluster, type ClusterSort } from '../../api/inventory'
import { KubernetesLogo, ProviderLogo } from '../../components/BrandIcons'
import { CloudIcon, ClusterIcon, WarningIcon } from '../../components/icons'
import { Banner } from '../../components/ui/Banner'
import { StatusBadge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { DataTable, type Column } from '../../components/ui/DataTable'
import { EmptyState } from '../../components/ui/EmptyState'
import { Switch } from '../../components/ui/Field'
import { FilterMenu, type FilterMenuOption } from '../../components/ui/FilterMenu'
import { LoadingState } from '../../components/ui/LoadingState'
import { PageHeader } from '../../components/ui/PageHeader'
import { Pagination } from '../../components/ui/Pagination'
import { RefreshIndicator } from '../../components/ui/RefreshIndicator'
import { SearchInput } from '../../components/ui/SearchInput'
import { SegmentedControl } from '../../components/ui/SegmentedControl'
import { StatCard } from '../../components/ui/StatCard'
import { Timestamp } from '../../components/ui/Timestamp'
import { usePolledResource } from '../../hooks/usePolledResource'
import { useUrlState } from '../../hooks/useUrlState'
import { isOlderThan, plural } from '../../lib/format'
import { emptyProviderCounts, providerLabels, providers, staleAfterMs } from '../../lib/providers'
import { statusMeta } from '../../lib/status'
import { ClusterDetailDrawer } from './ClusterDetailDrawer'
import {
  clusterPageSizes,
  clusterStatusGroups,
  clusterUrlDefaults,
  inventoryStatus,
  nextSort,
  parsePage,
  parsePageSize,
  parseProvider,
  parseSort,
  type ProviderFilter,
} from './cluster-filters'
import './clusters.css'

const pollIntervalMs = 30_000
const searchDebounceMs = 250

const statusOptions: FilterMenuOption[] = clusterStatusGroups.flatMap(({ group, values }) =>
  values.map((value) => ({ value, group, label: statusMeta('cluster', value).label })),
)

export function ClustersPage() {
  const [url, setUrl] = useUrlState(clusterUrlDefaults)
  const provider = parseProvider(url.provider)
  const providerParam = provider === 'all' ? '' : provider
  const search = url.search
  const sort = parseSort(url.sort)
  const order = url.order === 'desc' ? 'desc' : 'asc'
  const page = parsePage(url.page)
  const pageSize = parsePageSize(url.pageSize)
  const includeRemoved = url.removed === 'true'
  const [selectedCluster, setSelectedCluster] = useState<Cluster | null>(null)

  // What the search box shows runs ahead of the URL by the debounce. When the
  // URL moves on its own (a cleared filter, a new provider, back/forward), the
  // box follows it.
  const [draft, setDraft] = useState(search)
  const [syncedSearch, setSyncedSearch] = useState(search)
  if (syncedSearch !== search) {
    setSyncedSearch(search)
    setDraft(search)
  }

  useEffect(() => {
    if (draft === search) return
    const timer = window.setTimeout(() => setUrl({ search: draft, page: 1 }), searchDebounceMs)
    return () => window.clearTimeout(timer)
  }, [draft, search, setUrl])

  const load = useCallback(
    async (signal: AbortSignal) => {
      const [clusterPage, sources] = await Promise.all([
        getClusters(
          {
            provider: providerParam,
            search,
            source: url.source,
            status: url.status,
            includeRemoved,
            sort,
            order,
            page,
            pageSize,
          },
          signal,
        ),
        getSources(signal),
      ])
      return { clusterPage, sources }
    },
    [providerParam, search, url.source, url.status, includeRemoved, sort, order, page, pageSize],
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

  const refinements = Boolean(draft || url.source || url.status || includeRemoved)
  const hasFilters = refinements || provider !== 'all'

  function selectProvider(next: ProviderFilter) {
    // A source belongs to one provider, so a source filter does not survive
    // the switch to another.
    const keepSource = sources.find((item) => item.id === url.source)?.provider === next
    setDraft('')
    setUrl({ provider: next, search: '', source: keepSource ? url.source : '', page: 1 })
  }

  function searchEverywhere(value: string) {
    setDraft(value)
    // The global box always spans every provider, so typing into it while a
    // provider is picked drops that provider at once rather than after the
    // debounce.
    if (provider !== 'all') setUrl({ provider: 'all', search: value, source: '', page: 1 })
  }

  function clearSearch() {
    setDraft('')
    setUrl({ search: '', page: 1 })
  }

  function clearFilters() {
    setDraft('')
    setUrl({ provider: 'all', search: '', source: '', status: '', removed: false, page: 1 })
  }

  function toggleSort(column: string) {
    setUrl({ ...nextSort(sort, order, column as ClusterSort), page: 1 })
  }

  const sourceOptions: FilterMenuOption[] = sources
    .filter((item) => provider === 'all' || item.provider === provider)
    .map((item) => ({
      value: item.id,
      label: item.name,
      icon: <ProviderLogo provider={item.provider} />,
    }))

  const columns: Column<Cluster>[] = [
    {
      id: 'name',
      header: 'Cluster',
      sortable: true,
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
      sortable: true,
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
      cell: (cluster) => <span className="mono cell-muted">{cluster.location || '—'}</span>,
    },
    {
      id: 'version',
      header: 'Version',
      sortable: true,
      cell: (cluster) => (
        <span className="mono" title={cluster.kubernetesVersion || undefined}>
          {cluster.kubernetesVersion || '—'}
        </span>
      ),
    },
    {
      id: 'nodes',
      header: 'Nodes',
      sortable: true,
      align: 'end',
      className: 'cell-numeric',
      cell: (cluster) => cluster.nodeCount ?? '—',
    },
    {
      id: 'status',
      header: 'Health',
      sortable: true,
      cell: (cluster) => <StatusBadge domain="cluster" status={inventoryStatus(cluster)} />,
    },
    {
      id: 'lastSeen',
      header: 'Last seen',
      sortable: true,
      cell: (cluster) => (
        <Timestamp
          value={cluster.lastSeenAt}
          className={isOlderThan(cluster.lastSeenAt, staleAfterMs) ? 'seen-stale' : 'cell-muted'}
        />
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

  const viewHint = [
    provider === 'all' ? 'all providers' : providerLabels[provider],
    refinements && 'filtered',
  ]
    .filter(Boolean)
    .join(', ')

  return (
    <section className="page" aria-labelledby="clusters-heading">
      <PageHeader
        id="clusters-heading"
        title="Clusters"
        description="Every cluster your connected cloud sources have discovered."
        actions={
          <SearchInput
            label="Search all clusters across providers"
            placeholder="Search all clusters"
            value={provider === 'all' ? draft : ''}
            onChange={searchEverywhere}
            className="cluster-global-search"
          />
        }
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
          icon={<ClusterIcon />}
          value={fleetTotal}
          hint={plural(activeSources, 'active source')}
          aria-label={`${fleetTotal} clusters across ${activeSources} sources`}
        />
        <StatCard label="In this view" icon={<CloudIcon />} value={total} hint={viewHint} />
        <StatCard
          label="Sources behind"
          icon={<WarningIcon />}
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
        <div className="panel-toolbar cluster-toolbar">
          <SegmentedControl
            label="Filter by cloud provider"
            options={providerOptions}
            value={provider}
            onChange={selectProvider}
            className="provider-filter"
          />
          {provider !== 'all' && (
            <SearchInput
              label={`Search within ${providerLabels[provider]}`}
              placeholder={`Search ${providerLabels[provider]} clusters`}
              value={draft}
              autoFocus
              onChange={setDraft}
              className="cluster-scoped-search"
            />
          )}
        </div>

        <div className="cluster-filter-bar" role="group" aria-label="Cluster filters">
          <FilterMenu
            label="Source"
            allLabel="All sources"
            value={url.source}
            options={sourceOptions}
            fallbackLabel={(id) => sources.find((item) => item.id === id)?.name ?? id}
            onChange={(value) => setUrl({ source: value, page: 1 })}
          />
          <FilterMenu
            label="Status"
            allLabel="Any status"
            value={url.status}
            options={statusOptions}
            fallbackLabel={(value) => statusMeta('cluster', value).label}
            onChange={(value) => setUrl({ status: value, page: 1 })}
          />
          <Switch
            label="Show removed"
            checked={includeRemoved}
            onChange={(event) => setUrl({ removed: event.target.checked, page: 1 })}
            className="cluster-removed-switch"
          />
          {hasFilters && (
            <button type="button" className="link-button cluster-reset" onClick={clearFilters}>
              Reset filters
            </button>
          )}
        </div>

        <div className="panel-subheader">
          <h2>
            {provider === 'all' ? 'All providers' : providerLabels[provider]}
            <span>{plural(total, 'result')}</span>
          </h2>
          {draft && (
            <span className="chip">
              Name <strong>{draft}</strong>
              <button
                type="button"
                className="chip-remove"
                aria-label={`Remove name filter ${draft}`}
                onClick={clearSearch}
              >
                ×
              </button>
            </span>
          )}
        </div>

        <div aria-busy={inventory.loading || inventory.refreshing}>
          {inventory.loading ? (
            <LoadingState label="Loading cluster inventory…" rows={6} columns={7} />
          ) : clusters.length === 0 ? (
            <EmptyState
              icon={<KubernetesLogo />}
              title={
                hasFilters
                  ? 'Nothing matches those filters'
                  : inventory.error
                    ? 'Cluster inventory is unavailable'
                    : 'No clusters discovered yet'
              }
              description={
                hasFilters
                  ? 'Try a different search, or clear the filters to see every cluster.'
                  : 'Sync an enabled cloud source to pull your clusters in.'
              }
              action={
                hasFilters ? (
                  <Button size="sm" onClick={clearFilters}>
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
              sort={sort ? { column: sort, direction: order } : undefined}
              onSort={toggleSort}
              onRowClick={setSelectedCluster}
              // The name button is each row's keyboard way in; a focusable row
              // as well would make every row two tab stops.
              focusableRows={false}
              rowClassName={(cluster) => (cluster.removedAt ? 'is-removed' : '')}
            />
          )}
        </div>

        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          pageSizeOptions={clusterPageSizes}
          onPageChange={(next) => setUrl({ page: next })}
          onPageSizeChange={(size) => setUrl({ pageSize: size, page: 1 })}
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
