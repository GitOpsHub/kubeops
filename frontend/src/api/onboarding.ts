import { apiUrl, ensureOk, request, requestVoid } from './client'
import type { Cluster, ClusterPage } from './inventory'

// Re-exported so callers that branch on a 404 keep one import site.
export { ApiError } from './client'

export type DeploymentStatus = 'creating' | 'progressing' | 'healthy' | 'failed' | 'offboarded'
export type OnboardingStatus = 'progressing' | 'healthy' | 'partial' | 'failed' | 'offboarded'

export type ApplicationDeployment = {
  id: string
  onboardingId: string
  clusterId: string
  clusterName: string
  region: string
  sourceId: string
  providerResourceId: string
  argoApplication: string
  hasRegionValues: boolean
  // Present only when the cluster's Argo CD target exposes UI access.
  argoApplicationUrl?: string
  argoUsername?: string
  status: DeploymentStatus
  syncStatus: string
  healthStatus: string
  message?: string
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export type ApplicationOnboarding = {
  id: string
  name: string
  namespace: string
  environment: string
  region: string
  chartRepoUrl: string
  chartName: string
  chartRevision: string
  image: string
  valuesDigest: string
  valuesRepositoryUrl: string
  valuesRepositoryCloneUrl?: string
  valuesRepositoryName: string
  valuesRevision: string
  valuesCommitSha: string
  status: OnboardingStatus
  targets: ApplicationDeployment[]
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export type CreateOnboardingInput = {
  name: string
  namespace: string
  environment: string
  region: string
  clusterIds: string[]
  valuesYaml: string
  regionValues?: Record<string, string>
}

export type OnboardingDefaults = {
  chartRepoUrl: string
  chartName: string
  chartRevision: string
  valuesYaml: string
  valuesRepositoryBaseUrl: string
  valuesRevision: string
  // The backend's validation lists, first entry the default. Optional because
  // an older API omits them; callers fall back to the historical lists.
  environments?: string[]
  regions?: string[]
  capabilities?: { consoleMutations: boolean }
}

export type ApplicationOnboardingPage = {
  items: ApplicationOnboarding[]
  total: number
  page: number
  pageSize: number
}

export type ApplicationOnboardingFilter = {
  search?: string
  status?: OnboardingStatus | ''
  page?: number
  pageSize?: number
}

export const onboardingStatuses: OnboardingStatus[] = [
  'progressing',
  'healthy',
  'partial',
  'failed',
  'offboarded',
]

export const applicationsPageSize = 20

export async function getOnboardingClusters(signal?: AbortSignal) {
  const clusters: Cluster[] = []
  let page = 1
  while (true) {
    const response = await request<ClusterPage>(`/clusters?page=${page}&pageSize=200`, { signal })
    clusters.push(...response.items)
    if (clusters.length >= response.total) break
    page++
  }
  return clusters
}

export function getApplicationOnboardings(
  filter: ApplicationOnboardingFilter = {},
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({
    page: String(filter.page ?? 1),
    pageSize: String(filter.pageSize ?? applicationsPageSize),
  })
  if (filter.search) params.set('search', filter.search)
  if (filter.status) params.set('status', filter.status)
  return request<ApplicationOnboardingPage>(`/application-onboardings?${params}`, { signal })
}

const allApplicationsPageSize = 200
// A guard rail, not a target: without it a server that reports a larger `total`
// than it can page through would spin this loop forever.
const allApplicationsPageCap = 25

/**
 * Every onboarding the list would show, fetched page by page. Offboarded
 * releases are excluded server-side unless asked for, which is why that one
 * status is the only filter passed through.
 */
export async function getAllApplicationOnboardings(
  { includeOffboarded = false }: { includeOffboarded?: boolean } = {},
  signal?: AbortSignal,
) {
  const loaded: ApplicationOnboarding[] = []
  let page = 1
  let total: number
  do {
    const result = await getApplicationOnboardings(
      {
        status: includeOffboarded ? 'offboarded' : '',
        page,
        pageSize: allApplicationsPageSize,
      },
      signal,
    )
    if (result.items.length === 0) break
    loaded.push(...result.items)
    total = result.total
    page += 1
  } while (loaded.length < total && page <= allApplicationsPageCap)
  return loaded
}

export function getOnboardingDefaults(signal?: AbortSignal) {
  return request<OnboardingDefaults>('/application-onboardings/defaults', { signal })
}

export function getApplicationOnboarding(id: string, signal?: AbortSignal) {
  return request<ApplicationOnboarding>(`/application-onboardings/${encodeURIComponent(id)}`, {
    signal,
  })
}

export function createApplicationOnboarding(input: CreateOnboardingInput) {
  return request<ApplicationOnboarding>('/application-onboardings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

/** One Kubernetes object Argo CD manages for a deployment target. */
export type ResourceNode = {
  group: string
  version: string
  kind: string
  namespace: string
  name: string
  uid: string
  /** Empty for a root node; otherwise the uid of the owner. */
  parentUid: string
  healthStatus: string
  syncStatus: string
  createdAt: string
  images?: string[]
  info?: { name: string; value: string }[]
  /** Live cloud entry point enriched from the Service or Ingress manifest. */
  exposure?: {
    type: string
    addresses: string[]
    ports?: string[]
  }
}

/** The tuple Argo CD addresses a resource by. */
export type ResourceRef = Pick<ResourceNode, 'group' | 'version' | 'kind' | 'namespace' | 'name'>

function resourceQuery(ref: ResourceRef) {
  return new URLSearchParams({
    group: ref.group,
    version: ref.version,
    kind: ref.kind,
    namespace: ref.namespace,
    name: ref.name,
  })
}

function resourcePath(onboardingId: string, targetId: string) {
  return (
    `/application-onboardings/${encodeURIComponent(onboardingId)}` +
    `/targets/${encodeURIComponent(targetId)}/resources`
  )
}

export async function getTargetResources(
  onboardingId: string,
  targetId: string,
  signal?: AbortSignal,
) {
  const response = await request<{ items: ResourceNode[] }>(resourcePath(onboardingId, targetId), {
    signal,
  })
  return response.items ?? []
}

export async function getResourceManifest(
  onboardingId: string,
  targetId: string,
  ref: ResourceRef,
  signal?: AbortSignal,
) {
  const response = await request<{ manifest: string }>(
    `${resourcePath(onboardingId, targetId)}/manifest?${resourceQuery(ref)}`,
    { signal },
  )
  return response.manifest
}

export type ResourceManifestComparison = {
  desiredManifest: string
  manifest: string
}

export function getResourceManifestComparison(
  onboardingId: string,
  targetId: string,
  ref: ResourceRef,
  signal?: AbortSignal,
) {
  return request<ResourceManifestComparison>(
    `${resourcePath(onboardingId, targetId)}/manifest?${resourceQuery(ref)}`,
    { signal },
  )
}

export function deleteResource(onboardingId: string, targetId: string, ref: ResourceRef) {
  return requestVoid(`${resourcePath(onboardingId, targetId)}?${resourceQuery(ref)}`, {
    method: 'DELETE',
  })
}

export type PodLogEntry = {
  timestamp?: string
  podName?: string
  content?: string
  error?: string
}

/** Follows the backend's newline-delimited Pod log stream until it ends or the
 * caller aborts. Partial network chunks are buffered so one JSON entry is
 * never parsed before its newline arrives. */
export async function streamPodLogs(
  onboardingId: string,
  targetId: string,
  ref: ResourceRef,
  onEntry: (entry: PodLogEntry) => void,
  signal: AbortSignal,
) {
  const response = await ensureOk(
    await fetch(apiUrl(`${resourcePath(onboardingId, targetId)}/logs?${resourceQuery(ref)}`), {
      signal,
    }),
  )
  if (!response.body) throw new Error('The Pod log stream is unavailable')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  const consume = (line: string) => {
    if (!line.trim()) return
    const entry = JSON.parse(line) as PodLogEntry
    if (entry.error) throw new Error(entry.error)
    onEntry(entry)
  }

  while (true) {
    const { done, value } = await reader.read()
    buffered += decoder.decode(value, { stream: !done })
    const lines = buffered.split('\n')
    buffered = lines.pop() ?? ''
    for (const line of lines) consume(line)
    if (done) break
  }
  consume(buffered)
}

export function syncApplicationOnboarding(id: string) {
  return request<ApplicationOnboarding>(`/application-onboardings/${encodeURIComponent(id)}/sync`, {
    method: 'POST',
  })
}

export function scaleApplicationOnboarding(id: string, replicas: number) {
  return request<ApplicationOnboarding>(
    `/application-onboardings/${encodeURIComponent(id)}/scale`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ replicas }),
    },
  )
}

export function offboardApplicationOnboarding(id: string) {
  return request<ApplicationOnboarding>(
    `/application-onboardings/${encodeURIComponent(id)}/offboard`,
    { method: 'POST' },
  )
}
