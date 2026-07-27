import type { Cluster, ClusterPage } from './inventory'

export type DeploymentStatus = 'creating' | 'progressing' | 'healthy' | 'failed'
export type OnboardingStatus = 'progressing' | 'healthy' | 'partial' | 'failed'

export type ApplicationDeployment = {
  id: string
  onboardingId: string
  clusterId: string
  clusterName: string
  sourceId: string
  providerResourceId: string
  argoApplication: string
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
  chartRepoUrl: string
  chartName: string
  chartRevision: string
  valuesDigest: string
  status: OnboardingStatus
  targets: ApplicationDeployment[]
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export type CreateOnboardingInput = {
  name: string
  namespace: string
  clusterIds: string[]
  valuesYaml: string
}

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080/api'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, init)
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || `Request failed with status ${response.status}`)
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

export async function getApplicationOnboardings(signal?: AbortSignal) {
  const response = await request<{ items: ApplicationOnboarding[] }>(
    '/application-onboardings?limit=20',
    { signal },
  )
  return response.items
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
