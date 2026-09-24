import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderApp } from './test/render'
import { buildApplication, mockAPI } from './test/mock-api'

describe('App', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the overview from the inventory and onboarding APIs', async () => {
    mockAPI({
      applications: [
        buildApplication({ status: 'failed' }),
        buildApplication({ id: 'billing', name: 'billing-api', status: 'healthy' }),
      ],
    })
    renderApp()

    expect(await screen.findByRole('heading', { name: 'Overview', level: 1 })).toBeInTheDocument()
    const needsAttention = await screen.findByRole('region', { name: 'Needs attention' })
    expect(
      await within(needsAttention).findByRole('link', { name: /payments-api/ }),
    ).toHaveAttribute('href', '/applications/onboarding-1')
    expect(within(needsAttention).queryByText('billing-api')).not.toBeInTheDocument()
    const providers = screen.getByRole('region', { name: 'Clusters by provider' })
    expect(within(providers).getByText('EKS')).toBeInTheDocument()
    expect(within(providers).getByText('3')).toBeInTheDocument()
    const runs = screen.getByRole('region', { name: 'Recent sync runs' })
    expect(within(runs).getByText('AWS Platform')).toBeInTheDocument()

    // The sidebar owns the sync heartbeat on every page.
    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' })
    expect(await within(sidebar).findByText('Synced')).toBeInTheDocument()
  })

  it('renders the cross-cloud cluster inventory', async () => {
    mockAPI()
    renderApp('/clusters')

    expect(await screen.findByRole('heading', { name: 'Clusters', level: 1 })).toBeInTheDocument()
    expect(await screen.findByText('prod-us-east')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'All, 6 clusters' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('button', { name: 'EKS, 1 cluster' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'AKS, 3 clusters' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'GKE, 2 clusters' })).toBeInTheDocument()
    expect(screen.getByLabelText('6 clusters across 3 sources')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Source' })).not.toBeInTheDocument()
  })

  it('shows discovered clusters as active in the inventory health column', async () => {
    mockAPI({ clusterStatus: 'succeeded' })
    renderApp('/clusters')

    const cluster = await screen.findByRole('button', { name: /^prod-us-east/ })
    const row = cluster.closest('tr')

    expect(row).not.toBeNull()
    expect(within(row as HTMLElement).getByText('active')).toBeInTheDocument()
    expect(within(row as HTMLElement).queryByText('succeeded')).not.toBeInTheDocument()
  })

  it('filters and searches within a selected cloud provider', async () => {
    const { fetchMock } = mockAPI()
    renderApp('/clusters')
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

  it('returns to the complete fleet through the All provider option', async () => {
    const { fetchMock } = mockAPI()
    renderApp('/clusters')
    const user = userEvent.setup()
    const aks = await screen.findByRole('button', { name: 'AKS, 3 clusters' })
    const all = screen.getByRole('button', { name: 'All, 6 clusters' })

    await user.click(aks)
    expect(aks).toHaveAttribute('aria-pressed', 'true')
    expect(all).toHaveAttribute('aria-pressed', 'false')
    await user.click(all)

    await waitFor(() => {
      const clusterRequests = fetchMock.mock.calls
        .map(([request]) => String(request))
        .filter((url) => url.includes('/clusters?'))
      expect(clusterRequests.some((url) => !url.includes('provider='))).toBe(true)
    })
    expect(aks).toHaveAttribute('aria-pressed', 'false')
    expect(all).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('heading', { name: /All providers/ })).toBeInTheDocument()
  })

  it('uses the global search across all providers', async () => {
    const { fetchMock } = mockAPI()
    renderApp('/clusters')
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
    expect(screen.getByRole('button', { name: 'EKS, 1 cluster' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('queues a manual cloud source sync', async () => {
    const { fetchMock } = mockAPI()
    renderApp('/sources')
    const user = userEvent.setup()

    const syncButtons = await screen.findAllByRole('button', { name: 'Sync now' })
    await user.click(syncButtons[0])

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/cloud-sources/aws-platform/sync'),
      { method: 'POST' },
    )
  })

  it('shows live networking and confirms node-pool scaling', async () => {
    const { fetchMock } = mockAPI()
    renderApp('/clusters')
    const user = userEvent.setup()

    // Each row offers two ways in: the cluster name, and "Open details for …"
    // in the actions cell. Anchoring the name picks out the former.
    await user.click(await screen.findByRole('button', { name: /^prod-us-east/ }))

    expect(await screen.findByRole('dialog', { name: 'prod-us-east' })).toHaveClass(
      'cluster-detail-modal',
    )
    expect(document.querySelector('.detail-drawer')).not.toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Node pools' })).toBeInTheDocument()
    expect(await screen.findByText('vpc-123')).toBeInTheDocument()
    expect(screen.getByText('subnet-a, subnet-b')).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: 'Open in Argo CD' })).toHaveAttribute(
      'href',
      'http://localhost:8080/argo/target-id/applications',
    )
    expect(screen.queryByText(/Username/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Password/)).not.toBeInTheDocument()

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

  // Both the drawer and its confirmation used to listen for Escape on `window`,
  // so one keypress tore down both and the operator lost the whole drawer for
  // declining a scale. The dialogs are stacked layers now, and Escape is only
  // delivered to the top one.
  it('dismisses only the scale confirmation when Escape is pressed inside it', async () => {
    mockAPI()
    renderApp('/clusters')
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: /^prod-us-east/ }))
    await screen.findByRole('dialog', { name: 'prod-us-east' })

    const desiredInput = await screen.findByRole('spinbutton', { name: 'Desired nodes' })
    await user.clear(desiredInput)
    await user.type(desiredInput, '5')
    await user.click(screen.getByRole('button', { name: 'Review scale' }))
    expect(screen.getByRole('heading', { name: 'Scale workers?' })).toBeInTheDocument()

    await user.keyboard('{Escape}')

    expect(screen.queryByRole('heading', { name: 'Scale workers?' })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'prod-us-east' })).toBeInTheDocument()

    // And a second Escape, now that the confirmation is gone, closes the drawer.
    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'prod-us-east' })).not.toBeInTheDocument()
    })
  })

  it('shows an actionable API failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({ error: 'database is unavailable' }, { status: 503 }),
    )
    renderApp()

    expect(await screen.findByRole('alert')).toHaveTextContent('database is unavailable')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('navigates between the fleet and application routes', async () => {
    mockAPI()
    renderApp()
    const user = userEvent.setup()

    expect(await screen.findByRole('heading', { name: 'Overview', level: 1 })).toBeInTheDocument()
    const nav = screen.getByRole('navigation', { name: 'Primary' })

    for (const [link, heading] of [
      ['Clusters', 'Clusters'],
      ['Applications', 'Applications'],
      ['Cloud sources', 'Cloud sources'],
      ['Overview', 'Overview'],
    ]) {
      await user.click(within(nav).getByRole('link', { name: link }))
      expect(await screen.findByRole('heading', { name: heading, level: 1 })).toBeInTheDocument()
      expect(within(nav).getByRole('link', { name: link })).toHaveAttribute('aria-current', 'page')
    }
  })

  it('renders a not-found panel for unknown routes', async () => {
    mockAPI()
    renderApp('/nope')

    expect(await screen.findByText('Page not found')).toBeInTheDocument()
  })

  it('switches the theme and remembers the choice', async () => {
    // This environment provides no localStorage, which is also why the hook
    // guards every access to it.
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    })
    mockAPI()
    renderApp()
    const user = userEvent.setup()

    // With no stored choice and no matchMedia, the hook resolves to light —
    // the same answer as a browser reporting no dark preference.
    expect(document.documentElement.dataset.theme).toBe('light')

    await user.click(await screen.findByRole('button', { name: 'Switch to dark theme' }))

    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(store.get('kubeops-theme')).toBe('dark')
    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeInTheDocument()

    vi.unstubAllGlobals()
  })
})
