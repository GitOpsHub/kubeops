import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'

const timestamp = new Date().toISOString()

function mockAPI() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (request) => {
    const url = String(request)
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
    expect(screen.getByRole('button', { name: 'AWS, 1 cluster' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Azure, 3 clusters' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Google Cloud, 2 clusters' })).toBeInTheDocument()
    expect(screen.getByText('6')).toBeInTheDocument()
  })

  it('filters and searches within a selected cloud provider', async () => {
    const fetchMock = mockAPI()
    render(<App />)
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: 'Azure, 3 clusters' }))
    const scopedSearch = screen.getByRole('searchbox', { name: 'Search within Azure' })
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

    await user.click(await screen.findByRole('button', { name: 'AWS, 1 cluster' }))
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

  it('shows an actionable API failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({ error: 'database is unavailable' }, { status: 503 }),
    )
    render(<App />)

    expect(await screen.findByRole('alert')).toHaveTextContent('database is unavailable')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})
