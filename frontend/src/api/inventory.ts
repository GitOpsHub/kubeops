export type Provider = 'aws' | 'gcp' | 'azure' | 'docker' | 'minikube'

export type Cluster = {
  id: string
  sourceId: string
  sourceName: string
  provider: Provider
  providerResourceId: string
  name: string
  location: string
  kubernetesVersion: string
  status: string
  endpointAccess: 'public' | 'private' | 'both' | 'unknown'
  nodeCount: number | null
  metadata: Record<string, unknown>
  firstSeenAt: string
  lastSeenAt: string
  updatedAt: string
  removedAt: string | null
}

export type CloudSource = {
  id: string
  provider: Provider
  name: string
  scopeId: string
  regions: string[]
  enabled: boolean
  clusterCount: number
  lastSyncStatus: string
  lastSyncAt: string | null
  lastSyncError?: string
}

export type SyncRun = {
  id: string
  sourceId: string
  sourceName: string
  provider: Provider
  trigger: 'startup' | 'scheduled' | 'manual'
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  discoveredCount: number
  changedCount: number
  removedCount: number
  error?: string
  queuedAt: string
  startedAt: string | null
  completedAt: string | null
}

export type ClusterFilters = {
  provider?: Provider | ''
  source?: string
  search?: string
  includeRemoved?: boolean
  page?: number
  pageSize?: number
}

export type ClusterPage = {
  items: Cluster[]
  total: number
  page: number
  pageSize: number
}

export type NodePool = {
  id: string
  name: string
  desiredCount: number
  minCount: number | null
  maxCount: number | null
  autoscaling: 'enabled' | 'disabled' | 'unknown'
  status: string
  machineType?: string
  zones: string[]
  scalable: boolean
  unavailableReason?: string
}

export type ClusterNetworking = {
  provider: Provider
  endpointAccess: Cluster['endpointAccess']
  aws?: {
    vpcId?: string
    subnetIds: string[]
    clusterSecurityGroupId?: string
    additionalSecurityGroupIds: string[]
    publicAccessCidrs: string[]
    ipFamily?: string
    serviceIpv4Cidr?: string
    serviceIpv6Cidr?: string
  }
  gcp?: {
    network?: string
    subnetwork?: string
    podCidrs: string[]
    serviceCidrs: string[]
    controlPlaneIpv4Cidr?: string
    privateNodes: boolean
    privateEndpoint: boolean
    datapathProvider?: string
    networkPolicyEnabled: boolean
  }
  azure?: {
    subnetIds: string[]
    podSubnetIds: string[]
    networkPlugin?: string
    networkMode?: string
    networkPolicy?: string
    networkDataplane?: string
    podCidrs: string[]
    serviceCidrs: string[]
    dnsServiceIp?: string
    outboundType?: string
    loadBalancerSku?: string
    privateDnsZone?: string
  }
  local?: {
    apiServer?: string
  }
}

export type ClusterDetails = {
  cluster: Cluster
  capability: {
    canScaleNodes: boolean
    reason?: string
  }
  nodePools: NodePool[]
  networking: ClusterNetworking
}

export type ArgoAccess = {
  url: string
}

export type ScaleResult = {
  nodePoolId: string
  desiredCount: number
  status: 'accepted' | 'unchanged'
  providerOperationId?: string
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

export function getClusters(filters: ClusterFilters, signal?: AbortSignal) {
  const query = new URLSearchParams()
  if (filters.provider) query.set('provider', filters.provider)
  if (filters.source) query.set('source', filters.source)
  if (filters.search) query.set('search', filters.search)
  if (filters.includeRemoved) query.set('includeRemoved', 'true')
  query.set('page', String(filters.page || 1))
  query.set('pageSize', String(filters.pageSize || 25))
  return request<ClusterPage>(`/clusters?${query}`, { signal })
}

export async function getSources(signal?: AbortSignal) {
  const response = await request<{ items: CloudSource[] }>('/cloud-sources', { signal })
  return response.items
}

export async function getSyncRuns(signal?: AbortSignal) {
  const response = await request<{ items: SyncRun[] }>('/sync-runs?limit=12', { signal })
  return response.items
}

export function queueSourceSync(sourceId: string) {
  return request<SyncRun>(`/cloud-sources/${encodeURIComponent(sourceId)}/sync`, {
    method: 'POST',
  })
}

export function getClusterDetails(clusterId: string, signal?: AbortSignal) {
  return request<ClusterDetails>(`/clusters/${encodeURIComponent(clusterId)}/details`, { signal })
}

export function getClusterArgoAccess(clusterId: string, signal?: AbortSignal) {
  return request<ArgoAccess>(`/clusters/${encodeURIComponent(clusterId)}/argo-access`, { signal })
}

export function scaleNodePool(clusterId: string, poolId: string, desiredCount: number) {
  return request<ScaleResult>(
    `/clusters/${encodeURIComponent(clusterId)}/node-pools/${encodeURIComponent(poolId)}/scale`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ desiredCount }),
    },
  )
}
