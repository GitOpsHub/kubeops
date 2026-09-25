import { clusterSorts, type Cluster, type ClusterSort, type Provider } from '../../api/inventory'
import { providers } from '../../lib/providers'
import { statusMeta } from '../../lib/status'

export type ProviderFilter = Provider | 'all'

/**
 * The clusters list's URL contract. `search` is the one effective search: the
 * global box writes it with provider "all", the scoped box writes it beside a
 * provider. The overview's attention links build `?search=&source=&status=`.
 */
export const clusterUrlDefaults = {
  provider: 'all',
  search: '',
  source: '',
  status: '',
  removed: '',
  sort: '',
  order: 'asc',
  page: '1',
  pageSize: '25',
}

export type ClusterUrlState = typeof clusterUrlDefaults

export const clusterPageSizes = [25, 50, 100]

export function parseProvider(value: string): ProviderFilter {
  return (providers as string[]).includes(value) ? (value as Provider) : 'all'
}

export function parseSort(value: string): ClusterSort | '' {
  return (clusterSorts as string[]).includes(value) ? (value as ClusterSort) : ''
}

export function parsePage(value: string) {
  return Math.max(1, Math.floor(Number(value)) || 1)
}

export function parsePageSize(value: string) {
  const size = Number(value)
  return clusterPageSizes.includes(size) ? size : clusterPageSizes[0]
}

/**
 * The next sort after a header click: a new column starts ascending (except
 * "last seen", where newest first is the useful read), the same column flips.
 */
export function nextSort(current: ClusterSort | '', order: string, column: ClusterSort) {
  if (current === column) return { sort: column, order: order === 'desc' ? 'asc' : 'desc' }
  return { sort: column, order: column === 'lastSeen' ? 'desc' : 'asc' }
}

/**
 * The provider status values a filter can pick, grouped by what they mean.
 * The API matches them exactly, so these are the lower-cased words the
 * providers report.
 */
export const clusterStatusGroups: { group: string; values: string[] }[] = [
  { group: 'Healthy', values: ['active', 'running', 'succeeded', 'ready'] },
  {
    group: 'Changing',
    values: ['creating', 'provisioning', 'updating', 'reconciling', 'pending', 'scaling'],
  },
  { group: 'Problems', values: ['degraded', 'error', 'failed'] },
  { group: 'Stopping', values: ['deleting', 'stopping', 'stopped'] },
]

/**
 * What the inventory health column shows. A settled cluster reads "active"
 * whatever word its provider uses for settled (EKS "active", GKE "running",
 * AKS "succeeded"); anything else — changing, broken, unknown — keeps the
 * provider's own word, so a problem is never smoothed over.
 */
export function inventoryStatus(cluster: Cluster) {
  if (cluster.removedAt) return 'removed'
  if (!cluster.status) return 'active'
  return statusMeta('cluster', cluster.status).tone === 'ok' ? 'active' : cluster.status
}
