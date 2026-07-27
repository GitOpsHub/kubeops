import { render, screen } from '@testing-library/react'
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

    expect(await screen.findByRole('heading', { name: 'Fleet atlas' })).toBeInTheDocument()
    expect(await screen.findByText('prod-us-east')).toBeInTheDocument()
    expect(screen.getAllByText('Google Cloud Platform')).not.toHaveLength(0)
    expect(screen.getAllByText('Azure Platform')).not.toHaveLength(0)
    expect(screen.getByText('6')).toBeInTheDocument()
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
