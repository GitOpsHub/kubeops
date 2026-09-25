import { vi } from 'vitest'
import type { CloudSource, Cluster, SyncRun } from '../api/inventory'
import type {
  ApplicationDeployment,
  ApplicationOnboarding,
  OnboardingStatus,
  ResourceNode,
  ResourceRef,
} from '../api/onboarding'

export const timestamp = new Date().toISOString()

export function buildTarget(overrides: Partial<ApplicationDeployment> = {}): ApplicationDeployment {
  return {
    id: 'target-1',
    onboardingId: 'onboarding-1',
    clusterId: 'cluster-1',
    clusterName: 'prod-us-east',
    region: 'us-east-1',
    sourceId: 'aws-platform',
    providerResourceId: 'arn:aws:eks:us-east-1:123:cluster/prod',
    argoApplication: 'payments-api',
    hasRegionValues: false,
    argoApplicationUrl: 'https://argo.example.test/applications/payments-api',
    argoUsername: 'kubeops',
    status: 'progressing',
    syncStatus: 'OutOfSync',
    healthStatus: 'Progressing',
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    ...overrides,
  }
}

export function buildApplication(
  overrides: Partial<ApplicationOnboarding> = {},
): ApplicationOnboarding {
  return {
    id: 'onboarding-1',
    name: 'payments-api',
    namespace: 'payments',
    environment: 'prod',
    region: 'us-east-1',
    chartRepoUrl: 'https://charts.example.test',
    chartName: 'global-app',
    chartRevision: '1.2.3',
    image: 'registry.example.test/payments-api:2.4.1',
    valuesDigest: 'sha256:test',
    valuesRepositoryUrl: 'https://github.com/GitOpsHub/payments-api',
    valuesRepositoryCloneUrl: 'https://github.com/GitOpsHub/payments-api.git',
    valuesRepositoryName: 'payments-api',
    valuesRevision: 'main',
    valuesCommitSha: 'commit-1',
    status: 'progressing',
    targets: [buildTarget()],
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    ...overrides,
  }
}

export type MockState = {
  applications: ApplicationOnboarding[]
  argoAccessStatus: number
  clusterStatus: string
  resources: ResourceNode[]
  manifest: string
  desiredManifest: string
  /** Refs the UI asked to delete, in order. */
  deletedResources: ResourceRef[]
  scaledReplicas: number | null
  /** Inventory the cluster, source, and sync-run routes serve. */
  clusters: Cluster[]
  sources: CloudSource[]
  syncRuns: SyncRun[]
  /** Source IDs a manual sync was requested for, in order. */
  syncedSources: string[]
  /** Makes `POST /cloud-sources/:id/sync` fail with this message. */
  syncError: string | null
}

export function buildResource(overrides: Partial<ResourceNode> = {}): ResourceNode {
  return {
    group: 'apps',
    version: 'v1',
    kind: 'Deployment',
    namespace: 'payments',
    name: 'payments-api',
    uid: 'uid-deployment',
    parentUid: '',
    healthStatus: 'Healthy',
    syncStatus: 'Synced',
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

/**
 * Installs a fetch stub covering every endpoint the UI touches. The returned state is
 * mutable so a test can change what the API reports between polls.
 */
export function mockAPI(initial: Partial<MockState> = {}) {
  const state: MockState = {
    applications: initial.applications ?? [],
    argoAccessStatus: initial.argoAccessStatus ?? 200,
    clusterStatus: initial.clusterStatus ?? 'active',
    resources: initial.resources ?? [],
    manifest: initial.manifest ?? '{"kind":"Deployment"}',
    desiredManifest: initial.desiredManifest ?? initial.manifest ?? '{"kind":"Deployment"}',
    deletedResources: [],
    scaledReplicas: initial.scaledReplicas ?? null,
    clusters: initial.clusters ?? [buildCluster(initial.clusterStatus ?? 'active')],
    sources: initial.sources ?? defaultSources(),
    syncRuns: initial.syncRuns ?? [buildSyncRun()],
    syncedSources: [],
    syncError: initial.syncError ?? null,
  }

  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (request, init) => {
    const url = new URL(String(request), 'http://localhost')
    const path = url.pathname.replace(/^\/api/, '')
    const query = url.searchParams

    const resourceRoute = path.match(
      /^\/application-onboardings\/([^/]+)\/targets\/([^/]+)\/resources(\/manifest)?$/,
    )
    if (path.endsWith('/resources/logs')) {
      return new Response(
        [
          JSON.stringify({
            timestamp: '2026-08-04T12:00:00Z',
            podName: query.get('name'),
            content: 'server started on :8080',
          }),
          JSON.stringify({
            timestamp: '2026-08-04T12:00:01Z',
            podName: query.get('name'),
            content: 'GET /health 200',
          }),
        ].join('\n') + '\n',
        { headers: { 'Content-Type': 'application/x-ndjson' } },
      )
    }
    if (resourceRoute) {
      const [, , , manifestSuffix] = resourceRoute
      if (init?.method === 'DELETE') {
        state.deletedResources.push({
          group: query.get('group') ?? '',
          version: query.get('version') ?? '',
          kind: query.get('kind') ?? '',
          namespace: query.get('namespace') ?? '',
          name: query.get('name') ?? '',
        })
        state.resources = state.resources.filter((item) => item.name !== query.get('name'))
        return new Response(null, { status: 204 })
      }
      if (manifestSuffix) {
        return Response.json({
          manifest: state.manifest,
          desiredManifest: state.desiredManifest,
        })
      }
      return Response.json({ items: state.resources })
    }

    if (path === '/application-onboardings' && init?.method === 'POST') {
      const submitted = JSON.parse(String(init.body)) as {
        name: string
        namespace: string
        environment: string
        region: string
        clusterIds: string[]
      }
      const deploymentScope = `${submitted.environment}-${submitted.region}`
      const deploymentName = `${submitted.name}-${deploymentScope}`
      const created = buildApplication({
        id: 'onboarding-created',
        name: submitted.name,
        namespace: `${submitted.namespace}-${deploymentScope}`,
        environment: submitted.environment,
        region: submitted.region,
        valuesRepositoryUrl: `https://github.com/GitOpsHub/${submitted.name}`,
        valuesRepositoryName: submitted.name,
        targets: [
          buildTarget({
            onboardingId: 'onboarding-created',
            clusterId: submitted.clusterIds[0],
            argoApplication: deploymentName,
            argoApplicationUrl: `https://argo.example.test/applications/${deploymentName}`,
          }),
        ],
      })
      state.applications = [created, ...state.applications]
      return Response.json(created, { status: 201 })
    }

    if (path === '/application-onboardings/defaults') {
      return Response.json({
        chartRepoUrl: 'ghcr.io/gitopshub/charts',
        chartName: 'kubeops',
        chartRevision: '0.0.1',
        valuesYaml: 'replicaCount: 2\nimage:\n  repository: nginx\n',
        valuesRepositoryBaseUrl: 'https://github.com/GitOpsHub',
        valuesRevision: 'main',
      })
    }

    if (path === '/application-onboardings') {
      const search = (query.get('search') ?? '').toLowerCase()
      const status = query.get('status') as OnboardingStatus | null
      const page = Number(query.get('page') ?? '1')
      const pageSize = Number(query.get('pageSize') ?? '20')
      const matched = state.applications.filter((item) => {
        // Mirrors the backend: offboarded applications leave the default listing but
        // are still reachable by selecting that status explicitly.
        if (status ? item.status !== status : item.status === 'offboarded') return false
        if (!search) return true
        return (
          item.name.toLowerCase().includes(search) || item.namespace.toLowerCase().includes(search)
        )
      })
      return Response.json({
        items: matched.slice((page - 1) * pageSize, page * pageSize),
        total: matched.length,
        page,
        pageSize,
      })
    }

    const applicationScaleMatch = path.match(/^\/application-onboardings\/([^/]+)\/scale$/)
    if (applicationScaleMatch && init?.method === 'POST') {
      const id = decodeURIComponent(applicationScaleMatch[1])
      const found = state.applications.find((item) => item.id === id)
      if (!found) {
        return Response.json({ error: 'application onboarding not found' }, { status: 404 })
      }
      const body = JSON.parse(String(init.body)) as { replicas: number }
      state.scaledReplicas = body.replicas
      found.status = 'progressing'
      found.targets = found.targets.map((target) => ({
        ...target,
        status: 'progressing',
        syncStatus: 'OutOfSync',
        healthStatus: 'Progressing',
      }))
      return Response.json(found)
    }

    const lifecycleMatch = path.match(/^\/application-onboardings\/([^/]+)\/(sync|offboard)$/)
    if (lifecycleMatch && init?.method === 'POST') {
      const id = decodeURIComponent(lifecycleMatch[1])
      const found = state.applications.find((item) => item.id === id)
      if (!found) {
        return Response.json({ error: 'application onboarding not found' }, { status: 404 })
      }
      const offboard = lifecycleMatch[2] === 'offboard'
      found.status = offboard ? 'offboarded' : 'progressing'
      found.targets = found.targets.map((target) => ({
        ...target,
        status: offboard ? 'offboarded' : 'progressing',
        syncStatus: offboard ? 'Unknown' : 'OutOfSync',
        healthStatus: offboard ? 'Missing' : 'Progressing',
        message: offboard ? 'Removed from the cluster; GitHub values were preserved' : '',
      }))
      return Response.json(found)
    }

    if (path.startsWith('/application-onboardings/')) {
      const id = decodeURIComponent(path.slice('/application-onboardings/'.length))
      const found = state.applications.find((item) => item.id === id)
      if (!found) {
        return Response.json({ error: 'application onboarding not found' }, { status: 404 })
      }
      return Response.json(found)
    }

    if (path === '/clusters/cluster-1/node-pools/workers/scale') {
      return Response.json(
        {
          nodePoolId: 'workers',
          desiredCount: 5,
          status: 'accepted',
          providerOperationId: 'update-1',
        },
        { status: 202 },
      )
    }

    if (path === '/clusters/cluster-1/argo-access') {
      if (state.argoAccessStatus !== 200) {
        return Response.json(
          { error: 'Argo CD access is not configured for this cluster' },
          { status: state.argoAccessStatus },
        )
      }
      return Response.json({
        url: 'http://localhost:8080/argo/target-id/applications',
      })
    }

    if (path === '/clusters/cluster-1/details') {
      return Response.json({
        cluster: buildCluster(state.clusterStatus),
        capability: { canScaleNodes: true },
        nodePools: [
          {
            id: 'workers',
            name: 'workers',
            desiredCount: 3,
            minCount: 1,
            maxCount: 10,
            autoscaling: 'unknown',
            status: 'active',
            machineType: 'm6i.large',
            zones: [],
            scalable: true,
          },
        ],
        networking: {
          provider: 'aws',
          endpointAccess: 'private',
          aws: {
            vpcId: 'vpc-123',
            subnetIds: ['subnet-a', 'subnet-b'],
            clusterSecurityGroupId: 'sg-cluster',
            additionalSecurityGroupIds: [],
            publicAccessCidrs: [],
            ipFamily: 'ipv4',
            serviceIpv4Cidr: '10.100.0.0/16',
          },
        },
      })
    }

    if (path === '/clusters') {
      const page = Number(query.get('page') ?? '1')
      const pageSize = Number(query.get('pageSize') ?? '25')
      const provider = query.get('provider')
      const search = (query.get('search') ?? '').toLowerCase()
      // Source, status, removed, and sort mirror the API's filter and
      // whitelisted ORDER BY (NULLs last, id as the tiebreak).
      const source = query.get('source')
      const status = query.get('status')
      const includeRemoved = query.get('includeRemoved') === 'true'
      const sort = query.get('sort') as keyof typeof clusterSortKeys | null
      const descending = query.get('order') === 'desc'
      const matched = state.clusters.filter(
        (item) =>
          (!provider || item.provider === provider) &&
          (!search || item.name.toLowerCase().includes(search)) &&
          (!source || item.sourceId === source) &&
          (!status || item.status === status) &&
          (includeRemoved || !item.removedAt),
      )
      if (sort && clusterSortKeys[sort]) {
        const value = clusterSortKeys[sort]
        matched.sort((left, right) => {
          const a = value(left)
          const b = value(right)
          if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1
          const order = a < b ? -1 : a > b ? 1 : left.id.localeCompare(right.id)
          return descending ? -order : order
        })
      }
      return Response.json({
        items: matched
          .slice((page - 1) * pageSize, page * pageSize)
          .map((item) =>
            item.id === 'cluster-1' ? { ...item, status: state.clusterStatus } : item,
          ),
        total: matched.length,
        page,
        pageSize,
      })
    }

    if (path === '/cloud-sources') {
      return Response.json({ items: state.sources })
    }

    if (path === '/sync-runs') {
      const sourceId = query.get('sourceId')
      const limit = Number(query.get('limit') ?? '50')
      return Response.json({
        items: state.syncRuns
          .filter((run) => !sourceId || run.sourceId === sourceId)
          .slice(0, limit),
      })
    }

    const sourceSyncMatch = path.match(/^\/cloud-sources\/([^/]+)\/sync$/)
    if (sourceSyncMatch && init?.method === 'POST') {
      const sourceId = decodeURIComponent(sourceSyncMatch[1])
      if (state.syncError) return Response.json({ error: state.syncError }, { status: 409 })
      state.syncedSources.push(sourceId)
      const source = state.sources.find((item) => item.id === sourceId)
      const run = buildSyncRun({
        id: `run-${state.syncRuns.length + 1}`,
        sourceId,
        sourceName: source?.name ?? sourceId,
        trigger: 'manual',
        status: 'queued',
      })
      state.syncRuns = [run, ...state.syncRuns]
      return Response.json(run, { status: 202 })
    }

    return Response.json({ error: 'not found' }, { status: 404 })
  })

  return { fetchMock, state }
}

const clusterSortKeys: Record<string, (cluster: Cluster) => string | number | null> = {
  name: (cluster) => cluster.name,
  provider: (cluster) => cluster.provider,
  status: (cluster) => cluster.status,
  version: (cluster) => cluster.kubernetesVersion || null,
  nodes: (cluster) => cluster.nodeCount,
  lastSeen: (cluster) => cluster.lastSeenAt,
}

export function buildSyncRun(overrides: Partial<SyncRun> = {}): SyncRun {
  return {
    id: 'run-1',
    sourceId: 'aws-platform',
    sourceName: 'AWS Platform',
    provider: 'aws',
    trigger: 'scheduled',
    status: 'succeeded',
    discoveredCount: 1,
    changedCount: 0,
    removedCount: 0,
    queuedAt: timestamp,
    startedAt: timestamp,
    completedAt: timestamp,
    ...overrides,
  }
}

export function buildSource(overrides: Partial<CloudSource> = {}): CloudSource {
  return {
    id: 'aws-platform',
    provider: 'aws',
    name: 'AWS Platform',
    scopeId: '123',
    regions: ['us-east-1'],
    enabled: true,
    clusterCount: 1,
    lastSyncStatus: 'succeeded',
    lastSyncAt: timestamp,
    ...overrides,
  }
}

function defaultSources(): CloudSource[] {
  return [
    buildSource(),
    buildSource({
      id: 'gcp-platform',
      provider: 'gcp',
      name: 'Google Cloud Platform',
      scopeId: 'platform-project',
      regions: ['-'],
      clusterCount: 2,
    }),
    buildSource({
      id: 'azure-platform',
      provider: 'azure',
      name: 'Azure Platform',
      scopeId: 'subscription',
      regions: ['*'],
      clusterCount: 3,
    }),
  ]
}

export function buildCluster(status = 'active', overrides: Partial<Cluster> = {}): Cluster {
  return {
    id: 'cluster-1',
    sourceId: 'aws-platform',
    sourceName: 'AWS Platform',
    provider: 'aws',
    providerResourceId: 'arn:aws:eks:us-east-1:123:cluster/prod',
    name: 'prod-us-east',
    location: 'us-east-1',
    kubernetesVersion: '1.34',
    status,
    endpointAccess: 'private',
    nodeCount: 12,
    metadata: { platformVersion: 'eks.8' },
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
    updatedAt: timestamp,
    removedAt: null,
    ...overrides,
  }
}
