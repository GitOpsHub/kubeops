import {
  getApplicationOnboarding,
  getApplicationOnboardings,
  type ApplicationDeployment,
  type ApplicationOnboarding,
  type ResourceNode,
} from '../../api/onboarding'

export type ApplicationEndpoint = {
  label: string
  url: string
}

export type SyncSummary = 'Synced' | 'Out of Sync' | 'Sync pending'

export function releaseScope(record: ApplicationOnboarding) {
  return `${record.environment}-${record.region}`
}

export function releaseSyncStatus(targets: ApplicationDeployment[]): SyncSummary {
  const statuses = targets.map((target) =>
    target.syncStatus.trim().toLowerCase().replace(/\s+/g, ''),
  )
  if (statuses.length > 0 && statuses.every((status) => status === 'synced')) return 'Synced'
  if (statuses.some((status) => status === 'outofsync')) return 'Out of Sync'
  return 'Sync pending'
}

/**
 * Public URLs the application answers on, read off the Services and Ingresses
 * Argo CD reports. A port list of only non-TCP entries falls back to 443,
 * and CIDRs or user@host forms are skipped rather than turned into links.
 */
export function endpointLinks(nodes: ResourceNode[]) {
  const endpoints = new Map<string, ApplicationEndpoint>()
  for (const node of nodes) {
    if (!node.exposure) continue
    const ports = (node.exposure.ports ?? [])
      .map((value) => {
        const match = value.match(/^(\d+)\/TCP$/i)
        return match ? Number(match[1]) : 0
      })
      .filter(Boolean)
    const networkPorts = ports.length > 0 ? ports : [443]

    for (const address of node.exposure.addresses) {
      const trimmed = address.trim()
      if (!trimmed || trimmed.includes('/') || trimmed.includes('@')) continue
      const host = trimmed.includes(':') && !trimmed.startsWith('[') ? `[${trimmed}]` : trimmed
      for (const port of networkPorts) {
        const scheme = port === 443 ? 'https' : 'http'
        const portSuffix =
          (scheme === 'https' && port === 443) || (scheme === 'http' && port === 80)
            ? ''
            : `:${port}`
        const url = `${scheme}://${host}${portSuffix}`
        endpoints.set(url, { label: url, url })
      }
    }
  }
  return [...endpoints.values()]
}

/** A GitHub link to the exact values file (and commit) this release deploys. */
export function valuesFileLink(record: ApplicationOnboarding) {
  const repositoryUrl = record.valuesRepositoryUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
  if (!repositoryUrl) return null
  const hasRegionValues = record.targets.some(
    (target) => target.hasRegionValues && target.region === record.region,
  )
  const path = hasRegionValues
    ? `${record.environment}/${record.region}/values.yaml`
    : 'values.yaml'
  const revision = record.valuesCommitSha.trim() || record.valuesRevision.trim() || 'HEAD'
  const encodedPath = path.split('/').map(encodeURIComponent).join('/')
  return {
    path,
    revision,
    url: `${repositoryUrl}/blob/${encodeURIComponent(revision)}/${encodedPath}`,
  }
}

/**
 * The selected release plus every sibling release of the same application
 * (same name, other environments and regions), in scope order.
 */
export async function getApplicationReleases(id: string, signal?: AbortSignal) {
  const selected = await getApplicationOnboarding(id, signal)
  const releases: ApplicationOnboarding[] = []
  let page = 1
  while (true) {
    const response = await getApplicationOnboardings(
      { search: selected.name, page, pageSize: 200 },
      signal,
    )
    releases.push(...response.items)
    if (releases.length >= response.total || response.items.length === 0) break
    page += 1
  }

  const normalizedName = selected.name.trim().toLocaleLowerCase()
  const matching = releases.filter(
    (release) => release.name.trim().toLocaleLowerCase() === normalizedName,
  )
  if (!matching.some((release) => release.id === selected.id)) matching.push(selected)

  return matching.sort(
    (left, right) =>
      releaseScope(left).localeCompare(releaseScope(right)) ||
      left.createdAt.localeCompare(right.createdAt),
  )
}
