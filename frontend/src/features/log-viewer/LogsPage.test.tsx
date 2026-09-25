import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApplication, buildResource, buildTarget, mockAPI } from '../../test/mock-api'
import { renderApp } from '../../test/render'

afterEach(() => {
  vi.restoreAllMocks()
})

const resources = [
  buildResource({ uid: 'uid-dep', kind: 'Deployment', name: 'payments-api' }),
  buildResource({
    uid: 'uid-pod',
    kind: 'Pod',
    name: 'payments-api-abc',
    version: 'v1',
    group: '',
    parentUid: 'uid-dep',
  }),
  buildResource({ uid: 'uid-svc', kind: 'Service', name: 'payments-api', group: '' }),
]

function logRequests(fetchMock: ReturnType<typeof mockAPI>['fetchMock']) {
  return fetchMock.mock.calls
    .map(([request]) => new URL(String(request), 'http://localhost'))
    .filter((url) => url.pathname.endsWith('/logs'))
}

describe('logs page', () => {
  it('opens the deep-linked resource with the pickers filled in', async () => {
    const { fetchMock } = mockAPI({
      applications: [
        buildApplication({
          targets: [
            buildTarget({ id: 'target-1', clusterName: 'prod-us-east' }),
            buildTarget({ id: 'target-2', clusterName: 'prod-us-west', region: 'us-west-2' }),
          ],
        }),
      ],
      resources,
    })
    renderApp(
      '/applications/onboarding-1/logs?target=target-2&kind=Pod&name=payments-api-abc&namespace=payments',
    )

    expect(await screen.findByRole('heading', { name: 'Logs' })).toBeInTheDocument()
    const logs = await screen.findByLabelText('Live logs for payments-api-abc')
    expect(logs).toHaveTextContent('server started on :8080')
    expect(screen.getByRole('combobox', { name: 'Target' })).toHaveValue('target-2')
    expect(screen.getByRole('combobox', { name: 'Resource' })).toHaveValue(
      'Pod/payments/payments-api-abc',
    )
    expect(screen.getByRole('link', { name: 'payments-api' })).toHaveAttribute(
      'href',
      '/applications/onboarding-1',
    )
    const [request] = logRequests(fetchMock)
    expect(request.pathname).toBe('/api/application-onboardings/onboarding-1/targets/target-2/logs')
    expect(request.searchParams.get('kind')).toBe('Pod')
  })

  it('defaults to the workload, lists only loggable kinds, and switches resource', async () => {
    const { fetchMock } = mockAPI({ applications: [buildApplication()], resources })
    renderApp('/applications/onboarding-1/logs')
    const user = userEvent.setup()

    // A Deployment streams every pod it owns, so the pod column is on.
    await screen.findByLabelText('Live logs for payments-api')
    expect(screen.getByRole('button', { name: 'Pod column' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    const picker = screen.getByRole('combobox', { name: 'Resource' })
    expect(
      within(picker)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['payments-api', 'payments-api-abc'])

    await user.selectOptions(picker, 'Pod/payments/payments-api-abc')
    await screen.findByLabelText('Live logs for payments-api-abc')
    await waitFor(() =>
      expect(logRequests(fetchMock).at(-1)?.searchParams.get('name')).toBe('payments-api-abc'),
    )
  })

  it('says so when the application does not exist', async () => {
    mockAPI({ applications: [] })
    renderApp('/applications/missing/logs')
    expect(await screen.findByText('Application not found')).toBeInTheDocument()
  })
})

describe('logs from the resource list', () => {
  it('offers Logs on pods and workloads and opens the sheet with a full-screen link', async () => {
    mockAPI({
      applications: [buildApplication({ targets: [buildTarget({ id: 'target-1' })] })],
      resources,
    })
    renderApp('/applications/onboarding-1')
    const user = userEvent.setup()

    await user.click(await screen.findByRole('tab', { name: 'Kubernetes resources' }))
    await user.click(await screen.findByRole('button', { name: 'List' }))
    expect(screen.getByRole('button', { name: 'Logs for Pod payments-api-abc' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Logs for Service payments-api' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Logs for Deployment payments-api' }))
    const sheet = await screen.findByRole('dialog')
    const logs = await within(sheet).findByLabelText('Live logs for payments-api')
    expect(logs).toHaveTextContent('GET /health 200')
    expect(within(sheet).getByRole('link', { name: 'Open full screen' })).toHaveAttribute(
      'href',
      '/applications/onboarding-1/logs?target=target-1&kind=Deployment&name=payments-api&namespace=payments',
    )
  })
})
