import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'

const timestamp = new Date().toISOString()

function mockAPI() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (request, init) => {
    const url = String(request)
    if (url.endsWith('/application-onboardings') && init?.method === 'POST') {
      const submitted = JSON.parse(String(init.body)) as {
        name: string
        namespace: string
        clusterIds: string[]
      }
      return Response.json(
        {
          id: 'onboarding-1',
          name: submitted.name,
          namespace: submitted.namespace,
          chartRepoUrl: 'https://charts.example.test',
          chartName: 'global-app',
          chartRevision: '1.2.3',
          valuesDigest: 'sha256:test',
          valuesRepositoryUrl: `https://github.com/GitOpsHub/${submitted.name}`,
          valuesRepositoryName: submitted.name,
          valuesRevision: 'main',
          valuesCommitSha: 'commit-1',
          status: 'progressing',
          createdAt: timestamp,
          updatedAt: timestamp,
          completedAt: null,
          targets: [
            {
              id: 'target-1',
              onboardingId: 'onboarding-1',
              clusterId: submitted.clusterIds[0],
              clusterName: 'prod-us-east',
              sourceId: 'aws-platform',
              providerResourceId: 'arn:aws:eks:us-east-1:123:cluster/prod',
              argoApplication: submitted.name,
              status: 'progressing',
              syncStatus: 'OutOfSync',
              healthStatus: 'Progressing',
              createdAt: timestamp,
              updatedAt: timestamp,
              completedAt: null,
            },
          ],
        },
        { status: 201 },
      )
    }
    if (url.includes('/application-onboardings?')) {
      return Response.json({ items: [] })
    }
    if (url.endsWith('/application-onboardings/defaults')) {
      return Response.json({
        chartRepoUrl: 'ghcr.io/gitopshub/charts',
        chartName: 'kubeops',
        chartRevision: '0.0.1',
        valuesYaml: 'replicaCount: 2\nimage:\n  repository: nginx\n',
      })
    }
    if (url.includes('/clusters/cluster-1/node-pools/workers/scale')) {
      return Response.json(
        { nodePoolId: 'workers', desiredCount: 5, status: 'accepted', providerOperationId: 'update-1' },
        { status: 202 },
      )
    }
    if (url.endsWith('/clusters/cluster-1/details')) {
      return Response.json({
        cluster: {
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
          metadata: {},
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
          updatedAt: timestamp,
          removedAt: null,
        },
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
    if (url.includes('/clusters?')) {
      return Response.json({
        items: [
          {
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
          },
        ],
        total: 1,
        page: 1,
        pageSize: 25,
      })
    }
    if (url.endsWith('/cloud-sources')) {
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
    if (url.includes('/sync-runs')) {
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
    if (url.includes('/cloud-sources/aws-platform/sync')) {
      return Response.json(
        { id: 'run-2', sourceId: 'aws-platform', trigger: 'manual', status: 'queued' },
        { status: 202 },
      )
    }
    return Response.json({ error: 'not found' }, { status: 404 })
  })
}

describe('App', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the cross-cloud fleet inventory', async () => {
    mockAPI()
    render(<App />)

    expect(await screen.findByRole('heading', { name: 'Fleet control center' })).toBeInTheDocument()
    expect(await screen.findByText('prod-us-east')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /All clouds/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('button', { name: 'EKS, 1 cluster' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'AKS, 3 clusters' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'GKE, 2 clusters' })).toBeInTheDocument()
    expect(screen.getByLabelText('6 clusters across 3 sources')).toBeInTheDocument()
  })

  it('filters and searches within a selected cloud provider', async () => {
    const fetchMock = mockAPI()
    render(<App />)
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: 'AKS, 3 clusters' }))
    const scopedSearch = screen.getByRole('searchbox', { name: 'Search within AKS' })
    await user.type(scopedSearch, 'payments')

    await waitFor(() => {
      const clusterRequests = fetchMock.mock.calls
        .map(([request]) => String(request))
        .filter((url) => url.includes('/clusters?'))
      expect(clusterRequests.some((url) => url.includes('provider=azure'))).toBe(true)
      expect(clusterRequests.some((url) => url.includes('search=payments'))).toBe(true)
    })
  })

  it('uses the global search across all providers', async () => {
    const fetchMock = mockAPI()
    render(<App />)
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: 'EKS, 1 cluster' }))
    await user.type(
      screen.getByRole('searchbox', { name: 'Search all clusters across providers' }),
      'production',
    )

    await waitFor(() => {
      const clusterRequests = fetchMock.mock.calls
        .map(([request]) => String(request))
        .filter((url) => url.includes('/clusters?') && url.includes('search=production'))
      expect(clusterRequests.some((url) => !url.includes('provider='))).toBe(true)
    })
    expect(screen.getByRole('button', { name: /All clouds/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('queues a manual cloud source sync', async () => {
    const fetchMock = mockAPI()
    render(<App />)
    const user = userEvent.setup()

    const syncButtons = await screen.findAllByRole('button', { name: 'Sync now' })
    await user.click(syncButtons[0])

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/cloud-sources/aws-platform/sync'),
      { method: 'POST' },
    )
  })

  it('shows live networking and confirms node-pool scaling', async () => {
    const fetchMock = mockAPI()
    render(<App />)
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: /prod-us-east/ }))

    expect(await screen.findByRole('heading', { name: 'Node pools' })).toBeInTheDocument()
    expect(await screen.findByText('vpc-123')).toBeInTheDocument()
    expect(screen.getByText('subnet-a, subnet-b')).toBeInTheDocument()

    const desiredInput = screen.getByRole('spinbutton', { name: 'Desired nodes' })
    await user.clear(desiredInput)
    await user.type(desiredInput, '5')
    await user.click(screen.getByRole('button', { name: 'Review scale' }))

    expect(screen.getByRole('heading', { name: 'Scale workers?' })).toBeInTheDocument()
    expect(screen.getByText(/Autoscaling is unknown/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Confirm scale' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/clusters/cluster-1/node-pools/workers/scale'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ desiredCount: 5 }),
        }),
      )
    })
    expect(await screen.findByText(/Scaling workers to 5 nodes/)).toBeInTheDocument()
  })

  it('shows an actionable API failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({ error: 'database is unavailable' }, { status: 503 }),
    )
    render(<App />)

    expect(await screen.findByRole('alert')).toHaveTextContent('database is unavailable')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('onboards an application to selected clusters', async () => {
    const fetchMock = mockAPI()
    render(<App />)
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: 'Onboard application' }))
    expect(await screen.findByRole('heading', { name: 'Onboard an application' })).toBeInTheDocument()

    await user.type(screen.getByLabelText('Application name'), 'payments-api')
    await user.type(screen.getByLabelText('Namespace'), 'payments')
    await user.click(await screen.findByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Onboard application' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/application-onboardings'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            name: 'payments-api',
            namespace: 'payments',
            clusterIds: ['cluster-1'],
            valuesYaml: 'replicaCount: 2\nimage:\n  repository: nginx\n',
          }),
        }),
      )
    })
    expect(
      await screen.findByText((_, element) => element?.textContent === 'payments · global-app@1.2.3'),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /payments-api\/values.yaml/ })).toHaveAttribute(
      'href',
      'https://github.com/GitOpsHub/payments-api',
    )
    expect(screen.getAllByText('progressing').length).toBeGreaterThan(0)
  })
})
