import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import {
  buildApplication,
  buildCluster,
  buildSource,
  buildSyncRun,
  buildTarget,
  mockAPI,
} from '../../test/mock-api'
import { renderApp } from '../../test/render'

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

describe('OverviewPage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('makes one request for the whole dashboard', async () => {
    const { fetchMock } = mockAPI()
    renderApp()

    await screen.findByRole('region', { name: 'Recent sync runs' })
    const overviewCalls = fetchMock.mock.calls.filter(([request]) =>
      String(request).includes('/overview'),
    )
    expect(overviewCalls).toHaveLength(1)
    expect(
      fetchMock.mock.calls.some(([request]) =>
        String(request).includes('/application-onboardings'),
      ),
    ).toBe(false)
  })

  it('leads with KPI tiles computed from the overview', async () => {
    mockAPI({
      applications: [
        buildApplication({
          status: 'healthy',
          targets: [
            buildTarget({ healthStatus: 'Healthy', syncStatus: 'Synced', status: 'healthy' }),
            buildTarget({ id: 'target-2', healthStatus: 'Degraded', syncStatus: 'OutOfSync' }),
          ],
        }),
      ],
      syncRuns: [
        buildSyncRun({ startedAt: minutesAgo(5), completedAt: minutesAgo(4) }),
        buildSyncRun({ id: 'run-2', status: 'failed', completedAt: minutesAgo(30) }),
      ],
    })
    renderApp()

    const clusters = await screen.findByRole('link', { name: /^Clusters6/ })
    expect(clusters).toHaveAttribute('href', '/clusters')
    expect(
      within(clusters).getByRole('img', { name: /^Fleet size, last 14 days\. From 6 to 6/ }),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /^Applications1/ })).toHaveTextContent(
      '1 healthy · 0 need attention',
    )
    expect(screen.getByRole('link', { name: /^Healthy targets50%/ })).toHaveTextContent(
      '1 of 2 targets healthy',
    )
    expect(screen.getByRole('link', { name: /^Sync success · 24h50%/ })).toHaveTextContent(
      '1 of 2 runs',
    )
  })

  it('charts providers, application health, and sync activity with legend links', async () => {
    mockAPI({
      applications: [
        buildApplication({ status: 'failed' }),
        buildApplication({ id: 'billing', name: 'billing-api', status: 'healthy' }),
      ],
    })
    const { container } = renderApp()

    const providers = await screen.findByRole('region', { name: 'Clusters by provider' })
    expect(
      within(providers).getByRole('figure', { name: 'Clusters by provider: EKS 1, AKS 3, GKE 2' }),
    ).toBeInTheDocument()
    expect(within(providers).getByRole('link', { name: /AKS/ })).toHaveAttribute(
      'href',
      '/clusters?provider=azure',
    )

    const health = screen.getByRole('region', { name: 'Applications by health' })
    expect(within(health).getByRole('link', { name: /Failed\s*1/ })).toHaveAttribute(
      'href',
      '/applications?status=failed',
    )
    expect(within(health).getByRole('figure', { name: 'Target sync' })).toHaveTextContent(
      'Out of Sync',
    )

    const activity = screen.getByRole('region', { name: 'Sync activity' })
    expect(within(activity).getByRole('table', { name: 'Sync runs per day' })).toBeInTheDocument()
    expect(
      within(activity).getByRole('table', { name: 'Sync run duration per day' }),
    ).toBeInTheDocument()

    expect(await axe(container)).toHaveNoViolations()
  })

  it('lists every attention item, worst first, linking to filtered views', async () => {
    const user = userEvent.setup()
    mockAPI({
      clusterStatus: 'degraded',
      sources: [
        buildSource({ lastSyncStatus: 'failed', lastSyncError: 'AccessDenied' }),
        buildSource({
          id: 'gcp-platform',
          provider: 'gcp',
          name: 'GCP',
          lastSyncAt: minutesAgo(60),
        }),
      ],
      applications: Array.from({ length: 6 }, (_, index) =>
        buildApplication({ id: `app-${index}`, name: `app-${index}`, status: 'partial' }),
      ),
    })
    renderApp()

    const attention = await screen.findByRole('region', { name: 'Needs attention' })
    expect(within(attention).getByText('9 items, worst first')).toBeInTheDocument()
    const links = within(attention).getAllByRole('link')
    // Six shown before "View all"; the failed source outranks partial releases.
    expect(links).toHaveLength(6)
    expect(links[0]).toHaveAccessibleName(/AWS Platform.*AccessDenied.*Source.*failed/)
    expect(links[0]).toHaveAttribute('href', '/sources?source=aws-platform')

    await user.click(within(attention).getByRole('button', { name: 'View all 9' }))
    const expanded = within(attention).getAllByRole('link')
    expect(expanded).toHaveLength(9)
    expect(expanded[7]).toHaveAccessibleName(/prod-us-east.*Cluster.*degraded/)
    expect(expanded[7]).toHaveAttribute(
      'href',
      '/clusters?source=aws-platform&status=degraded&search=prod-us-east',
    )
    expect(expanded[8]).toHaveAccessibleName(/GCP.*No successful sync.*Source.*stale/)
    expect(within(attention).getByRole('button', { name: 'Show fewer' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  })

  it('shows recent sync runs as a table with outcome and duration', async () => {
    mockAPI({
      syncRuns: [
        buildSyncRun({
          discoveredCount: 4,
          changedCount: 2,
          removedCount: 1,
          startedAt: '2026-09-24T10:00:00Z',
          completedAt: '2026-09-24T10:00:42Z',
        }),
        buildSyncRun({
          id: 'run-2',
          sourceName: 'Azure Platform',
          provider: 'azure',
          trigger: 'manual',
          status: 'running',
          completedAt: null,
        }),
      ],
    })
    renderApp()

    const region = await screen.findByRole('region', { name: 'Recent sync runs' })
    const rows = within(
      within(region).getByRole('table', { name: 'Recent sync runs' }),
    ).getAllByRole('row')
    expect(rows[1]).toHaveTextContent(/AWS Platform\s*scheduled\s*succeeded\s*4\s*2\s*1\s*42s/)
    expect(rows[2]).toHaveTextContent(/Azure Platform\s*manual\s*running\s*1\s*0\s*0\s*In progress/)
  })

  it('explains how to add a cloud source when the fleet is empty', async () => {
    mockAPI({ sources: [], clusters: [], syncRuns: [], applications: [] })
    renderApp()

    expect(await screen.findByText('Connect a cloud source to get started')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open cloud sources' })).toHaveAttribute(
      'href',
      '/sources',
    )
    expect(screen.queryByRole('region', { name: 'Needs attention' })).not.toBeInTheDocument()
  })

  it('announces loading over a skeleton of the final layout', async () => {
    const { fetchMock } = mockAPI()
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (request, init) =>
      String(request).includes('/overview')
        ? new Promise<Response>(() => {})
        : original(request, init),
    )
    renderApp()

    expect(await screen.findByText('Loading overview…')).toBeInTheDocument()
    // The cards are already in place, so nothing jumps when the data lands.
    expect(screen.getByRole('region', { name: 'Needs attention' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Sync activity' })).toBeInTheDocument()
  })

  it('offers a retry when the overview cannot be loaded', async () => {
    const user = userEvent.setup()
    const { fetchMock } = mockAPI()
    const original = fetchMock.getMockImplementation()!
    let failing = true
    fetchMock.mockImplementation(async (request, init) =>
      failing && String(request).includes('/overview')
        ? Response.json({ error: 'overview query timed out' }, { status: 500 })
        : original(request, init),
    )
    renderApp()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Overview could not be loaded')
    expect(alert).toHaveTextContent('overview query timed out')

    failing = false
    await user.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('region', { name: 'Recent sync runs' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps unknown providers in the donut as Other', async () => {
    mockAPI({
      sources: [buildSource({ clusterCount: 2 })],
      clusters: [buildCluster()],
    })
    const { fetchMock } = { fetchMock: vi.mocked(globalThis.fetch) }
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (request, init) => {
      const response = await original(request, init)
      if (!String(request).includes('/overview')) return response
      const body = await response.json()
      body.clusters.byProvider.openshift = 1
      body.clusters.total = 3
      return Response.json(body)
    })
    renderApp()

    const providers = await screen.findByRole('region', { name: 'Clusters by provider' })
    expect(
      within(providers).getByRole('figure', { name: 'Clusters by provider: EKS 2, Other 1' }),
    ).toBeInTheDocument()
  })
})
