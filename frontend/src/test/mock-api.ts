import { vi } from 'vitest'
import type {
  ApplicationDeployment,
  ApplicationOnboarding,
  OnboardingStatus,
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
    chartRepoUrl: 'https://charts.example.test',
    chartName: 'global-app',
    chartRevision: '1.2.3',
    valuesDigest: 'sha256:test',
    valuesRepositoryUrl: 'https://github.com/GitOpsHub/payments-api',
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
  argoPassword: string
  argoAccessStatus: number
}

/**
 * Installs a fetch stub covering every endpoint the UI touches. The returned state is
 * mutable so a test can change what the API reports between polls.
 */
export function mockAPI(initial: Partial<MockState> = {}) {
  const state: MockState = {
    applications: initial.applications ?? [],
    argoPassword: initial.argoPassword ?? 'argo-password',
    argoAccessStatus: initial.argoAccessStatus ?? 200,
  }

  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (request, init) => {
    const url = new URL(String(request), 'http://localhost')
    const path = url.pathname.replace(/^\/api/, '')
    const query = url.searchParams

    if (path === '/application-onboardings' && init?.method === 'POST') {
      const submitted = JSON.parse(String(init.body)) as {
        name: string
        namespace: string
        clusterIds: string[]
      }
      const created = buildApplication({
        id: 'onboarding-created',
        name: submitted.name,
        namespace: submitted.namespace,
        valuesRepositoryUrl: `https://github.com/GitOpsHub/${submitted.name}`,
        valuesRepositoryName: submitted.name,
        targets: [
          buildTarget({
            onboardingId: 'onboarding-created',
            clusterId: submitted.clusterIds[0],
            argoApplication: submitted.name,
            argoApplicationUrl: `https://argo.example.test/applications/${submitted.name}`,
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
      })
    }

    if (path === '/application-onboardings') {
      const search = (query.get('search') ?? '').toLowerCase()
      const status = query.get('status') as OnboardingStatus | null
      const page = Number(query.get('page') ?? '1')
      const pageSize = Number(query.get('pageSize') ?? '20')
      const matched = state.applications.filter((item) => {
        if (status && item.status !== status) return false
        if (!search) return true
        return (
          item.name.toLowerCase().includes(search) ||
          item.namespace.toLowerCase().includes(search)
        )
      })
      return Response.json({
        items: matched.slice((page - 1) * pageSize, page * pageSize),
        total: matched.length,
        page,
        pageSize,
      })
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
        url: 'https://argo.example.test',
        username: 'kubeops',
        password: state.argoPassword,
      })
    }

    if (path === '/clusters/cluster-1/details') {
      return Response.json({
        cluster: buildCluster(),
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
      return Response.json({
        items: [buildCluster()],
        total: 1,
        page: 1,
        pageSize: 25,
      })
    }

    if (path === '/cloud-sources') {
      return Response.json({
        items: [
          {
            id: 'aws-platform',
            provider: 'aws',
            name: 'AWS Platform',
            scopeId: '123',
            regions: ['us-east-1'],
            enabled: true,
            clusterCount: 1,
            lastSyncStatus: 'succeeded',
            lastSyncAt: timestamp,
          },
          {
            id: 'gcp-platform',
            provider: 'gcp',
            name: 'Google Cloud Platform',
            scopeId: 'platform-project',
            regions: ['-'],
            enabled: true,
            clusterCount: 2,
            lastSyncStatus: 'succeeded',
            lastSyncAt: timestamp,
          },
          {
            id: 'azure-platform',
            provider: 'azure',
            name: 'Azure Platform',
            scopeId: 'subscription',
            regions: ['*'],
            enabled: true,
            clusterCount: 3,
            lastSyncStatus: 'succeeded',
            lastSyncAt: timestamp,
          },
        ],
      })
    }

    if (path === '/sync-runs') {
      return Response.json({
        items: [
          {
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
          },
        ],
      })
    }

    if (path === '/cloud-sources/aws-platform/sync') {
      return Response.json(
        { id: 'run-2', sourceId: 'aws-platform', trigger: 'manual', status: 'queued' },
        { status: 202 },
      )
    }

    return Response.json({ error: 'not found' }, { status: 404 })
  })

  return { fetchMock, state }
}

function buildCluster() {
  return {
    id: 'cluster-1',
    sourceId: 'aws-platform',
    sourceName: 'AWS Platform',
    provider: 'aws',
    providerResourceId: 'arn:aws:eks:us-east-1:123:cluster/prod',
    name: 'prod-us-east',
    location: 'us-east-1',
    kubernetesVersion: '1.34',
    status: 'active',
    endpointAccess: 'private',
    nodeCount: 12,
    metadata: { platformVersion: 'eks.8' },
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
    updatedAt: timestamp,
    removedAt: null,
  }
}
