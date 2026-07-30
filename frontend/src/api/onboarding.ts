import type { Cluster, ClusterPage } from './inventory'

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

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080/api'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, init)
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new ApiError(
      body.error || `Request failed with status ${response.status}`,
      response.status,
    )
  }
  return response.json() as Promise<T>
}

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

export function getOnboardingDefaults(signal?: AbortSignal) {
  return request<OnboardingDefaults>('/application-onboardings/defaults', { signal })
}

export function getApplicationOnboarding(id: string, signal?: AbortSignal) {
  return request<ApplicationOnboarding>(
    `/application-onboardings/${encodeURIComponent(id)}`,
    { signal },
  )
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
export type ResourceRef = Pick<
  ResourceNode,
  'group' | 'version' | 'kind' | 'namespace' | 'name'
>

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
  const response = await request<{ items: ResourceNode[] }>(
    resourcePath(onboardingId, targetId),
    { signal },
  )
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

export async function deleteResource(
  onboardingId: string,
  targetId: string,
  ref: ResourceRef,
) {
  const url = `${apiBaseUrl}${resourcePath(onboardingId, targetId)}?${resourceQuery(ref)}`
  const response = await fetch(url, { method: 'DELETE' })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new ApiError(
      body.error || `Request failed with status ${response.status}`,
      response.status,
    )
  }
}

export function syncApplicationOnboarding(id: string) {
  return request<ApplicationOnboarding>(
    `/application-onboardings/${encodeURIComponent(id)}/sync`,
    { method: 'POST' },
  )
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
