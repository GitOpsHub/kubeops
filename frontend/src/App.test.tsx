import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { mockAPI } from './test/mock-api'

function renderApp(route = '/') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <App />
    </MemoryRouter>,
  )
}

describe('App', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the cross-cloud fleet inventory', async () => {
    mockAPI()
    renderApp()

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
    const { fetchMock } = mockAPI()
    renderApp()
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
    const { fetchMock } = mockAPI()
    renderApp()
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
    const { fetchMock } = mockAPI()
    renderApp()
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
    renderApp()
    const user = userEvent.setup()

    // Each row offers two ways in: the cluster name, and "Open details for …"
    // in the actions cell. Anchoring the name picks out the former.
    await user.click(await screen.findByRole('button', { name: /^prod-us-east/ }))

    expect(await screen.findByRole('heading', { name: 'Node pools' })).toBeInTheDocument()
    expect(await screen.findByText('vpc-123')).toBeInTheDocument()
    expect(screen.getByText('subnet-a, subnet-b')).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: 'Open Argo CD' })).toHaveAttribute(
      'href',
      'https://argo.example.test',
    )

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
    renderApp()

    expect(await screen.findByRole('alert')).toHaveTextContent('database is unavailable')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('navigates between the fleet and application routes', async () => {
    mockAPI()
    renderApp()
    const user = userEvent.setup()

    expect(await screen.findByRole('heading', { name: 'Fleet control center' })).toBeInTheDocument()

    await user.click(screen.getByRole('link', { name: 'Applications' }))
    expect(
      await screen.findByRole('heading', { name: 'Onboarded applications' }),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('link', { name: 'Fleet' }))
    expect(await screen.findByRole('heading', { name: 'Fleet control center' })).toBeInTheDocument()
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
