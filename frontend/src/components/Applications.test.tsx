import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { buildApplication, buildTarget, mockAPI } from '../test/mock-api'

function renderApp(route: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <App />
    </MemoryRouter>,
  )
}

function onboardingRequests(fetchMock: ReturnType<typeof mockAPI>['fetchMock']) {
  return fetchMock.mock.calls
    .map(([request]) => String(request))
    .filter((url) => url.includes('/application-onboardings?'))
}

// userEvent.setup() installs its own clipboard stub, so the spy has to replace it
// afterwards to observe what the component writes.
function stubClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  return writeText
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('applications list', () => {
  it('lists onboarded applications with regions, targets, and status', async () => {
    mockAPI({
      applications: [
        buildApplication({
          status: 'partial',
          targets: [
            buildTarget({ id: 'target-1', region: 'us-east-1' }),
            buildTarget({ id: 'target-2', region: 'eu-west-1', clusterName: 'prod-eu' }),
          ],
        }),
      ],
    })
    renderApp('/applications')

    const row = await screen.findByRole('row', { name: /payments-api/ })
    expect(within(row).getByText('payments')).toBeInTheDocument()
    expect(within(row).getByText('eu-west-1, us-east-1')).toBeInTheDocument()
    expect(within(row).getByText('2 targets')).toBeInTheDocument()
    expect(within(row).getByText('partial')).toBeInTheDocument()
  })

  it('applies bookmarked filters from the URL', async () => {
    const { fetchMock } = mockAPI({
      applications: [buildApplication({ status: 'healthy' })],
    })
    renderApp('/applications?search=payments&status=healthy&page=2')

    await waitFor(() => {
      expect(
        onboardingRequests(fetchMock).some(
          (url) =>
            url.includes('search=payments') &&
            url.includes('status=healthy') &&
            url.includes('page=2'),
        ),
      ).toBe(true)
    })
    expect(screen.getByRole('searchbox', { name: /Search applications/ })).toHaveValue('payments')
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('healthy')
  })

  it('stores search and status filters in the URL', async () => {
    const { fetchMock } = mockAPI({ applications: [buildApplication({ status: 'failed' })] })
    renderApp('/applications')
    const user = userEvent.setup()

    await user.type(await screen.findByRole('searchbox', { name: /Search applications/ }), 'pay')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'failed')

    await waitFor(() => {
      expect(
        onboardingRequests(fetchMock).some(
          (url) => url.includes('search=pay') && url.includes('status=failed'),
        ),
      ).toBe(true)
    })
  })

  it('pages through results', async () => {
    const { fetchMock } = mockAPI({
      applications: Array.from({ length: 25 }, (_, index) =>
        buildApplication({ id: `onboarding-${index}`, name: `app-${index}` }),
      ),
    })
    renderApp('/applications')
    const user = userEvent.setup()

    expect(await screen.findByText(/Page 1 of 2 · 25 applications/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next' }))

    await waitFor(() => {
      expect(onboardingRequests(fetchMock).some((url) => url.includes('page=2'))).toBe(true)
    })
    expect(await screen.findByText(/Page 2 of 2/)).toBeInTheDocument()
  })

  it('opens an application detail from the list', async () => {
    mockAPI({ applications: [buildApplication()] })
    renderApp('/applications')
    const user = userEvent.setup()

    await user.click(await screen.findByRole('link', { name: 'payments-api' }))

    expect(
      await screen.findByRole('heading', { name: 'payments-api', level: 1 }),
    ).toBeInTheDocument()
    expect(screen.getByText('Deployment targets')).toBeInTheDocument()
  })

  it('reports an unreachable applications API', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({ error: 'database is unavailable' }, { status: 503 }),
    )
    renderApp('/applications')

    expect(await screen.findByRole('alert')).toHaveTextContent('database is unavailable')
  })
})

describe('application detail', () => {
  it('renders each target with sync, health, failure message, and an Argo deep link', async () => {
    const { fetchMock } = mockAPI({
      applications: [
        buildApplication({
          status: 'partial',
          targets: [
            buildTarget({
              id: 'target-1',
              status: 'healthy',
              syncStatus: 'Synced',
              healthStatus: 'Healthy',
            }),
            buildTarget({
              id: 'target-2',
              clusterName: 'prod-eu',
              clusterId: 'cluster-2',
              region: 'eu-west-1',
              status: 'failed',
              syncStatus: 'OutOfSync',
              healthStatus: 'Degraded',
              message: 'image pull backoff',
            }),
          ],
        }),
      ],
    })
    renderApp('/applications/onboarding-1')

    const failing = await screen.findByRole('article', { name: 'Deployment target prod-eu' })
    expect(within(failing).getByText('image pull backoff')).toBeInTheDocument()
    expect(within(failing).getByText('Degraded')).toBeInTheDocument()
    expect(within(failing).getByRole('link', { name: 'Open in Argo CD' })).toHaveAttribute(
      'href',
      'https://argo.example.test/applications/payments-api',
    )
    expect(screen.getByText('Some targets are healthy while others failed.', { exact: false }))
      .toBeInTheDocument()

    // Credentials must stay untouched until the operator asks for them.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('argo-access'))).toBe(false)
  })

  it('copies the Argo password to the clipboard only when requested', async () => {
    const { fetchMock, state } = mockAPI({
      applications: [buildApplication()],
      argoPassword: 'super-secret',
    })
    renderApp('/applications/onboarding-1')
    const user = userEvent.setup()
    const writeText = stubClipboard()

    await user.click(await screen.findByRole('button', { name: 'Copy password' }))

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('super-secret')
    })
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes('argo-access')),
    ).toHaveLength(1)
    expect(await screen.findByText('Password copied to the clipboard.')).toBeInTheDocument()
    // The password is never rendered.
    expect(screen.queryByText(state.argoPassword)).not.toBeInTheDocument()
  })

  it('reports a failed password copy', async () => {
    mockAPI({ applications: [buildApplication()], argoAccessStatus: 404 })
    renderApp('/applications/onboarding-1')
    const user = userEvent.setup()
    const writeText = stubClipboard()

    await user.click(await screen.findByRole('button', { name: 'Copy password' }))

    expect(
      await screen.findByText('Argo CD access is not configured for this cluster'),
    ).toBeInTheDocument()
    expect(writeText).not.toHaveBeenCalled()
  })

  it('omits Argo actions when the target has no UI access', async () => {
    mockAPI({
      applications: [
        buildApplication({
          targets: [buildTarget({ argoApplicationUrl: undefined, argoUsername: undefined })],
        }),
      ],
    })
    renderApp('/applications/onboarding-1')

    expect(
      await screen.findByText('Argo CD UI access is not configured for this cluster.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copy password' })).not.toBeInTheDocument()
  })

  it('shows an empty state when the application has no targets', async () => {
    mockAPI({ applications: [buildApplication({ targets: [] })] })
    renderApp('/applications/onboarding-1')

    expect(await screen.findByText(/has no deployment targets/)).toBeInTheDocument()
  })

  it('polls every five seconds until the deployment reaches a terminal state', async () => {
    // Only the polling interval is faked so React Testing Library keeps using real
    // timers for its own async helpers.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { fetchMock, state } = mockAPI({ applications: [buildApplication()] })
    renderApp('/applications/onboarding-1')

    await waitFor(() => {
      expect(screen.getAllByText('progressing').length).toBeGreaterThan(0)
    })
    const initialCalls = fetchMock.mock.calls.length

    state.applications = [
      buildApplication({
        status: 'healthy',
        targets: [
          buildTarget({ status: 'healthy', syncStatus: 'Synced', healthStatus: 'Healthy' }),
        ],
      }),
    ]
    // Nothing refreshes before the interval elapses.
    act(() => vi.advanceTimersByTime(4_000))
    expect(fetchMock.mock.calls.length).toBe(initialCalls)

    act(() => vi.advanceTimersByTime(1_000))
    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(initialCalls)
    })
    expect(await screen.findByText(/Every target is synced and healthy./)).toBeInTheDocument()
    expect(screen.getAllByText('healthy').length).toBeGreaterThan(0)
  })

  it('reports a missing application', async () => {
    mockAPI({ applications: [] })
    renderApp('/applications/onboarding-missing')

    expect(await screen.findByText('Application not found')).toBeInTheDocument()
  })

  it('reports a failing detail request', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({ error: 'database is unavailable' }, { status: 503 }),
    )
    renderApp('/applications/onboarding-1')

    expect(await screen.findByRole('alert')).toHaveTextContent('database is unavailable')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})

describe('application onboarding form', () => {
  it('redirects to the new application detail after a successful submission', async () => {
    const { fetchMock } = mockAPI()
    renderApp('/applications/new')
    const user = userEvent.setup()

    expect(
      await screen.findByRole('heading', { name: 'Onboard an application' }),
    ).toBeInTheDocument()
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
            regionValues: {},
          }),
        }),
      )
    })

    // The redirect happens even though the deployment is still progressing.
    expect(
      await screen.findByRole('heading', { name: 'payments-api', level: 1 }),
    ).toBeInTheDocument()
    expect(screen.getAllByText('progressing').length).toBeGreaterThan(0)
  })

  it('keeps the operator on the form when submission fails', async () => {
    mockAPI()
    renderApp('/applications/new')
    const user = userEvent.setup()

    await screen.findByRole('heading', { name: 'Onboard an application' })
    await user.type(screen.getByLabelText('Application name'), 'payments-api')
    await user.type(screen.getByLabelText('Namespace'), 'payments')
    await user.click(screen.getByRole('button', { name: 'Onboard application' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Select at least one target region.',
    )
    expect(screen.getByRole('heading', { name: 'Onboard an application' })).toBeInTheDocument()
  })
})
