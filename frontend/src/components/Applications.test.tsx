import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { buildApplication, buildResource, buildTarget, mockAPI } from '../test/mock-api'

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
    expect(within(row).getByText('us-east-1')).toBeInTheDocument()
    expect(within(row).getByText('2 targets')).toBeInTheDocument()
    expect(within(row).getByText('prod')).toBeInTheDocument()
    expect(within(row).getByText('partial')).toBeInTheDocument()
  })

  it('expands a row into one flat table of deployment targets', async () => {
    mockAPI({
      applications: [
        buildApplication({
          targets: [
            buildTarget({ id: 'target-1', region: 'us-east-1' }),
            buildTarget({ id: 'target-2', region: 'eu-west-1', clusterName: 'prod-eu' }),
          ],
        }),
      ],
    })
    renderApp('/applications')
    const user = userEvent.setup()

    expect(
      screen.queryByRole('table', { name: 'Deployment targets for payments-api' }),
    ).not.toBeInTheDocument()

    const expander = await screen.findByRole('button', {
      name: 'Show deployment targets for payments-api',
    })
    await user.click(expander)

    const targets = await screen.findByRole('table', {
      name: 'Deployment targets for payments-api',
    })
    const rows = within(targets).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(2)
    // Regions sort within the environment, so eu-west-1 leads.
    expect(within(rows[0]).getByText('eu-west-1')).toBeInTheDocument()
    expect(within(rows[0]).getByText('prod-eu')).toBeInTheDocument()
    expect(within(rows[1]).getByText('prod-us-east')).toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: 'Hide deployment targets for payments-api' }),
    )
    expect(
      screen.queryByRole('table', { name: 'Deployment targets for payments-api' }),
    ).not.toBeInTheDocument()
  })

  it('groups regional releases by application name and shows their platform IDs', async () => {
    mockAPI({
      applications: [
        buildApplication({
          id: 'onboarding-east',
          name: 'nginx',
          namespace: 'nginx-dev-us-east-1',
          environment: 'dev',
          region: 'us-east-1',
          targets: [
            buildTarget({
              id: 'target-east',
              onboardingId: 'onboarding-east',
              sourceId: 'aws-platform',
              region: 'us-east-1',
            }),
          ],
        }),
        buildApplication({
          id: 'onboarding-west',
          name: 'nginx',
          namespace: 'nginx-dev-us-west-2',
          environment: 'dev',
          region: 'us-west-2',
          targets: [
            buildTarget({
              id: 'target-west',
              onboardingId: 'onboarding-west',
              sourceId: 'gcp-platform',
              region: 'us-west-2',
            }),
          ],
        }),
      ],
    })
    renderApp('/applications')
    const user = userEvent.setup()

    const applicationLinks = await screen.findAllByRole('link', { name: 'nginx' })
    expect(applicationLinks).toHaveLength(1)
    const row = applicationLinks[0].closest('tr')
    expect(row).not.toBeNull()
    expect(within(row!).getByText('aws-platform')).toBeInTheDocument()
    expect(within(row!).getByText('gcp-platform')).toBeInTheDocument()
    expect(within(row!).getByText('2 releases')).toBeInTheDocument()
    expect(within(row!).getByText('2 targets')).toBeInTheDocument()
    expect(screen.getByText('Showing 1–1 of 1 application')).toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: 'Show deployment targets for nginx' }),
    )
    // The UUID moves off the row and into the expanded header, where it is
    // copied rather than scanned.
    expect(screen.getByText('ID onboarding-east')).toBeInTheDocument()
    const targets = screen.getByRole('table', { name: 'Deployment targets for nginx' })
    const targetRows = within(targets).getAllByRole('row').slice(1)
    expect(targetRows).toHaveLength(2)
    expect(within(targetRows[0]).getByText('us-east-1')).toBeInTheDocument()
    expect(within(targetRows[0]).getByText('nginx-dev-us-east-1')).toBeInTheDocument()
    expect(within(targetRows[1]).getByText('us-west-2')).toBeInTheDocument()

    await user.click(screen.getByRole('link', { name: 'Open application →' }))
    expect(
      await screen.findByRole('button', { name: 'View dev-us-west-2 release' }),
    ).toBeInTheDocument()
  })

  it('orders expanded targets by dev, qa, and prod environment', async () => {
    mockAPI({
      applications: [
        buildApplication({
          id: 'prod-release',
          name: 'nginx',
          environment: 'prod',
          region: 'us-east-1',
          targets: [buildTarget({ id: 'target-prod', onboardingId: 'prod-release' })],
        }),
        buildApplication({
          id: 'dev-release',
          name: 'nginx',
          environment: 'dev',
          region: 'us-east-2',
          targets: [buildTarget({ id: 'target-dev', onboardingId: 'dev-release' })],
        }),
        buildApplication({
          id: 'qa-release',
          name: 'nginx',
          environment: 'qa',
          region: 'us-east-1',
          targets: [buildTarget({ id: 'target-qa', onboardingId: 'qa-release' })],
        }),
      ],
    })
    renderApp('/applications')
    const user = userEvent.setup()

    await user.click(
      await screen.findByRole('button', { name: 'Show deployment targets for nginx' }),
    )

    const targets = screen.getByRole('table', { name: 'Deployment targets for nginx' })
    const rows = within(targets).getAllByRole('row').slice(1)
    expect(
      rows.map((row) => within(row).getAllByRole('cell')[0].textContent),
    ).toEqual(['dev', 'qa', 'prod'])
  })

  it('filters by application status without truncating the matched application', async () => {
    mockAPI({
      applications: [
        buildApplication({
          id: 'nginx-east',
          name: 'nginx',
          environment: 'dev',
          region: 'us-east-1',
          status: 'healthy',
          targets: [buildTarget({ id: 'target-east', onboardingId: 'nginx-east' })],
        }),
        buildApplication({
          id: 'nginx-west',
          name: 'nginx',
          environment: 'dev',
          region: 'us-west-2',
          status: 'failed',
          targets: [
            buildTarget({
              id: 'target-west',
              onboardingId: 'nginx-west',
              region: 'us-west-2',
              clusterName: 'dev-us-west',
            }),
          ],
        }),
        buildApplication({ id: 'billing', name: 'billing-api', status: 'healthy' }),
      ],
    })
    // Filtering releases server-side used to drop the failing half of nginx and
    // leave the row claiming one healthy target.
    renderApp('/applications?status=partial')

    const row = (await screen.findByRole('link', { name: 'nginx' })).closest('tr')
    expect(within(row!).getByText('2 releases')).toBeInTheDocument()
    expect(within(row!).getByText('2 targets')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'billing-api' })).not.toBeInTheDocument()
  })

  it('sorts applications by status severity', async () => {
    mockAPI({
      applications: [
        buildApplication({ id: 'alpha', name: 'alpha', status: 'healthy' }),
        buildApplication({ id: 'bravo', name: 'bravo', status: 'failed' }),
      ],
    })
    renderApp('/applications')
    const user = userEvent.setup()

    const names = async () =>
      (await screen.findAllByRole('link', { name: /^(alpha|bravo)$/ })).map(
        (link) => link.textContent,
      )
    expect(await names()).toEqual(['alpha', 'bravo'])

    await user.click(screen.getByRole('button', { name: 'Status' }))
    expect(await names()).toEqual(['bravo', 'alpha'])
  })

  it('applies bookmarked filters from the URL without filtering the fetch', async () => {
    const { fetchMock } = mockAPI({
      applications: [
        buildApplication({ status: 'healthy' }),
        buildApplication({ id: 'billing', name: 'billing-api', namespace: 'billing' }),
      ],
    })
    renderApp('/applications?search=payments&status=healthy')

    expect(await screen.findByRole('link', { name: 'payments-api' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'billing-api' })).not.toBeInTheDocument()
    expect(screen.getByRole('searchbox', { name: /Search applications/ })).toHaveValue('payments')
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('healthy')

    const requests = onboardingRequests(fetchMock)
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every((url) => url.includes('pageSize=200'))).toBe(true)
    expect(
      requests.every((url) => !url.includes('search=') && !url.includes('status=')),
    ).toBe(true)
  })

  it('debounces the search into the URL and filters in place', async () => {
    const { fetchMock } = mockAPI({
      applications: [
        buildApplication(),
        buildApplication({ id: 'billing', name: 'billing-api', namespace: 'billing' }),
      ],
    })
    renderApp('/applications')
    const user = userEvent.setup()

    await user.type(await screen.findByRole('searchbox', { name: /Search applications/ }), 'bill')

    // The chip is written from the URL, so seeing it proves the debounced write landed.
    expect(await screen.findByLabelText('Remove name filter bill')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'billing-api' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'payments-api' })).not.toBeInTheDocument()

    // Typing never refetches: the list is filtered in memory.
    const before = onboardingRequests(fetchMock).length
    await user.type(screen.getByRole('searchbox', { name: /Search applications/ }), 'ing')
    await waitFor(() =>
      expect(screen.getByLabelText('Remove name filter billing')).toBeInTheDocument(),
    )
    expect(onboardingRequests(fetchMock).length).toBe(before)
  })

  it('pages through results at the chosen page size', async () => {
    const { fetchMock } = mockAPI({
      applications: Array.from({ length: 60 }, (_, index) =>
        buildApplication({
          id: `onboarding-${index}`,
          name: `app-${String(index).padStart(2, '0')}`,
        }),
      ),
    })
    renderApp('/applications')
    const user = userEvent.setup()

    expect(await screen.findByText('Showing 1–50 of 60 applications')).toBeInTheDocument()

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Applications per page' }),
      '25',
    )
    expect(await screen.findByText('Showing 1–25 of 60 applications')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(await screen.findByText('Showing 26–50 of 60 applications')).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: 'app-30' })).toBeInTheDocument()
    expect(onboardingRequests(fetchMock).every((url) => url.includes('pageSize=200'))).toBe(true)
  })

  it('opens an application detail from the list', async () => {
    mockAPI({ applications: [buildApplication()] })
    renderApp('/applications')
    const user = userEvent.setup()

    await user.click(await screen.findByRole('link', { name: 'payments-api' }))

    expect(
      await screen.findByRole('heading', { name: 'payments-api', level: 1 }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('article', { name: 'Deployment target prod-us-east' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Deployment targets' })).not.toBeInTheDocument()
  })

  it('keeps loading and reports the failure when the applications API is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({ error: 'database is unavailable' }, { status: 503 }),
    )
    renderApp('/applications')

    const state = await screen.findByRole('status')
    expect(state).toHaveTextContent('Loading applications…')
    expect(state).toHaveTextContent('database is unavailable')
    expect(within(state).getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    // The list still polls, so it must not claim the fleet is empty.
    expect(screen.queryByText('No applications onboarded yet')).not.toBeInTheDocument()
  })
})

describe('application detail', () => {
  it('renders compact deployment identities with namespaces and Argo deep links', async () => {
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
      resources: [
        buildResource({
          group: '',
          version: 'v1',
          kind: 'Service',
          name: 'payments-api-service',
          exposure: {
            type: 'LoadBalancer',
            addresses: ['35.237.212.233'],
            ports: ['80/TCP', '443/TCP'],
          },
        }),
      ],
    })
    renderApp('/applications/onboarding-1')

    const failing = await screen.findByRole('article', { name: 'Deployment target prod-eu' })
    expect(within(failing).getByText('payments')).toBeInTheDocument()
    expect(screen.getByText('registry.example.test/payments-api:2.4.1')).toBeInTheDocument()
    expect(
      within(failing).getByRole('link', { name: 'Open prod-eu in Argo CD' }),
    ).toHaveAttribute(
      'href',
      'https://argo.example.test/applications/payments-api',
    )
    const syncState = await screen.findByLabelText('Application sync: Out of Sync')
    expect(within(syncState).getByText('Out of Sync')).toHaveClass('status-badge--warn')
    const deployButton = screen.getByRole('button', { name: 'Deploy' })
    expect(
      syncState.compareDocumentPosition(deployButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Scale' }).querySelector('.scale-horizontal-icon'),
    ).not.toBeNull()
    expect(screen.queryByText('Application state')).not.toBeInTheDocument()
    expect(screen.queryByText('Awaiting sync')).not.toBeInTheDocument()
    expect(
      within(document.querySelector('.topbar') as HTMLElement).queryByText('payments-api'),
    ).not.toBeInTheDocument()
    const endpointBar = screen.getByRole('region', { name: 'Application URLs' })
    expect(
      await within(endpointBar).findByRole('link', { name: 'http://35.237.212.233' }),
    ).toHaveAttribute('href', 'http://35.237.212.233')
    expect(
      within(endpointBar).getByRole('link', { name: 'https://35.237.212.233' }),
    ).toHaveAttribute('href', 'https://35.237.212.233')

    // Credentials must stay untouched until the operator asks for them.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('argo-access'))).toBe(false)
  })

  it('lists Kubernetes resources in ownership order and shows their detail', async () => {
    mockAPI({
      applications: [
        buildApplication({ targets: [buildTarget({ id: 'target-1', region: 'us-east-1' })] }),
      ],
      resources: [
        buildResource({ uid: 'uid-pod', kind: 'Pod', name: 'payments-api-abc', parentUid: 'uid-rs' }),
        buildResource({ uid: 'uid-rs', kind: 'ReplicaSet', name: 'payments-api-1', parentUid: 'uid-dep' }),
        buildResource({ uid: 'uid-dep', kind: 'Deployment', name: 'payments-api' }),
      ],
      manifest: '{"kind":"Deployment","metadata":{"name":"payments-api"}}',
    })
    renderApp('/applications/onboarding-1')
    const user = userEvent.setup()

    await user.click(await screen.findByRole('tab', { name: 'Kubernetes resources' }))

    // Owners come before the objects they own, so the tree reads top-down.
    const rows = await screen.findAllByRole('listitem')
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('payments-api'),
      expect.stringContaining('payments-api-1'),
      expect.stringContaining('payments-api-abc'),
    ])

    await user.click(screen.getByText('payments-api-1'))
    expect(screen.getByText('apps/v1')).toBeInTheDocument()

    // Selecting a resource loads its live definition directly as YAML.
    expect(await screen.findByLabelText('YAML for payments-api-1')).toHaveTextContent(
      'kind: Deployment',
    )
  })

  it('shows declarative manifests without Pods or ReplicaSets', async () => {
    mockAPI({
      applications: [
        buildApplication({
          targets: [
            buildTarget({
              status: 'healthy',
              syncStatus: 'Synced',
              healthStatus: 'Healthy',
            }),
          ],
        }),
      ],
      resources: [
        buildResource({ uid: 'deployment', kind: 'Deployment', name: 'payments-api' }),
        buildResource({ uid: 'service', group: '', kind: 'Service', name: 'payments-service' }),
        buildResource({ uid: 'pod', kind: 'Pod', name: 'payments-api-abc' }),
        buildResource({ uid: 'replicaset', kind: 'ReplicaSet', name: 'payments-api-1' }),
      ],
      desiredManifest:
        '{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"payments-api"},"spec":{"replicas":2}}',
      manifest:
        '{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"payments-api","uid":"generated"},"spec":{"replicas":3},"status":{"readyReplicas":3}}',
    })
    renderApp('/applications/onboarding-1')
    const user = userEvent.setup()

    const yamlButton = await screen.findByRole('button', { name: 'Manifest' })
    const syncState = screen.getByLabelText('Application sync: Synced')
    const syncBadge = within(syncState).getByText('Synced')
    expect(
      syncBadge.compareDocumentPosition(yamlButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      yamlButton.compareDocumentPosition(
        screen.getByRole('button', { name: 'Deploy' }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    await user.click(yamlButton)

    const modal = await screen.findByRole('dialog', { name: 'Kubernetes manifests' })
    expect(within(modal).getByText('Deployed to')).toBeInTheDocument()
    expect(within(modal).getAllByText('prod-us-east')).toHaveLength(3)
    expect(within(modal).getByText('payments')).toBeInTheDocument()
    expect(within(modal).getAllByText('Synced').length).toBeGreaterThanOrEqual(1)
    expect(
      within(modal).queryByRole('combobox', { name: 'Resource manifest' }),
    ).not.toBeInTheDocument()
    expect(
      within(modal).getByRole('tablist', { name: 'Resource manifests' }),
    ).toBeInTheDocument()
    expect(within(modal).getAllByRole('tab')).toHaveLength(2)
    expect(
      within(modal).queryByRole('tab', { name: /Pod payments-api-abc/ }),
    ).not.toBeInTheDocument()
    expect(
      within(modal).queryByRole('tab', { name: /ReplicaSet payments-api-1/ }),
    ).not.toBeInTheDocument()
    const deploymentDiff = await within(modal).findByLabelText(
      'Manifest diff for payments-api',
    )
    expect(deploymentDiff).toHaveTextContent('Helm rendered')
    expect(deploymentDiff).toHaveTextContent('replicas: 2')
    expect(deploymentDiff).toHaveTextContent('replicas: 3')
    expect(deploymentDiff).not.toHaveTextContent('uid: generated')
    expect(
      within(modal).getByRole('button', { name: 'Generated fields hidden' }),
    ).toHaveAttribute('aria-pressed', 'true')

    await user.click(
      within(modal).getByRole('button', { name: 'Generated fields hidden' }),
    )
    expect(await within(modal).findByText('uid: generated')).toBeInTheDocument()

    await user.click(
      within(modal).getByRole('tab', { name: /Service payments-service/ }),
    )
    expect(
      await within(modal).findByLabelText('Manifest diff for payments-service'),
    ).toBeInTheDocument()
    await user.click(within(modal).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog', { name: 'Kubernetes manifests' })).not.toBeInTheDocument()
  })

  it('deletes a resource only after the warning is confirmed', async () => {
    const { fetchMock } = mockAPI({
      applications: [
        buildApplication({ targets: [buildTarget({ id: 'target-1', region: 'us-east-1' })] }),
      ],
      resources: [buildResource({ uid: 'uid-dep', kind: 'Deployment', name: 'payments-api' })],
    })
    renderApp('/applications/onboarding-1')
    const user = userEvent.setup()

    await user.click(await screen.findByRole('tab', { name: 'Kubernetes resources' }))
    // The list view is where a row carries its own delete action.
    await user.click(await screen.findByRole('button', { name: 'List' }))
    await user.click(
      await screen.findByRole('button', { name: 'Delete Deployment payments-api' }),
    )

    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByText(/recreates it on the next sync/)).toBeInTheDocument()

    // Cancelling must not touch the cluster.
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(
      fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE'),
    ).toBe(false)

    await user.click(screen.getByRole('button', { name: 'Delete Deployment payments-api' }))
    await user.click(screen.getByRole('button', { name: 'Delete Deployment' }))

    const deleteCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE',
    )
    expect(String(deleteCall?.[0])).toContain('kind=Deployment')
    expect(String(deleteCall?.[0])).toContain('name=payments-api')
    expect(await screen.findByText(/was deleted from/)).toBeInTheDocument()
  })

  it('toggles between the tree and the list, remembering the choice', async () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    })
    mockAPI({
      applications: [
        buildApplication({ targets: [buildTarget({ id: 'target-1', region: 'us-east-1' })] }),
      ],
      resources: [buildResource({ uid: 'uid-dep', kind: 'Deployment', name: 'payments-api' })],
    })
    const view = renderApp('/applications/onboarding-1')
    const user = userEvent.setup()

    await user.click(await screen.findByRole('tab', { name: 'Kubernetes resources' }))

    // The graph is the default, and it is a graph, not a table.
    expect(await screen.findByRole('button', { name: 'Tree' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.queryByRole('columnheader', { name: /Kind/ })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'List' }))
    expect(await screen.findByRole('columnheader', { name: /Kind/ })).toBeInTheDocument()
    expect(store.get('kubeops-resource-view')).toBe('list')

    // A fresh mount opens on the remembered view.
    view.unmount()
    renderApp('/applications/onboarding-1')
    await user.click(await screen.findByRole('tab', { name: 'Kubernetes resources' }))
    expect(await screen.findByRole('columnheader', { name: /Kind/ })).toBeInTheDocument()

    vi.unstubAllGlobals()
  })

  it('sorts and filters the resource list', async () => {
    mockAPI({
      applications: [
        buildApplication({ targets: [buildTarget({ id: 'target-1', region: 'us-east-1' })] }),
      ],
      resources: [
        buildResource({ uid: 'uid-dep', kind: 'Deployment', name: 'api' }),
        buildResource({ uid: 'uid-pod-b', kind: 'Pod', name: 'api-b', parentUid: 'uid-dep' }),
        buildResource({ uid: 'uid-pod-a', kind: 'Pod', name: 'api-a', parentUid: 'uid-dep' }),
      ],
    })
    renderApp('/applications/onboarding-1')
    const user = userEvent.setup()

    await user.click(await screen.findByRole('tab', { name: 'Kubernetes resources' }))
    await user.click(await screen.findByRole('button', { name: 'List' }))

    const names = () =>
      screen
        .getAllByRole('row')
        .slice(1)
        .map((row) => within(row).getAllByRole('cell')[1].textContent)

    expect(names()).toEqual(['api', 'api-a', 'api-b'])

    // Sorting by kind descending puts the pods above the deployment.
    await user.click(screen.getByRole('button', { name: /Kind/ }))
    expect(screen.getByRole('columnheader', { name: /Kind/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    )
    expect(names()).toEqual(['api-a', 'api-b', 'api'])

    await user.selectOptions(screen.getByRole('combobox', { name: 'Kind' }), 'Pod')
    expect(names()).toEqual(['api-a', 'api-b'])
  })

  it('opens the same YAML modal from a graph card', async () => {
    mockAPI({
      applications: [
        buildApplication({ targets: [buildTarget({ id: 'target-1', region: 'us-east-1' })] }),
      ],
      resources: [buildResource({ uid: 'uid-dep', kind: 'Deployment', name: 'payments-api' })],
    })
    renderApp('/applications/onboarding-1')
    const user = userEvent.setup()

    await user.click(await screen.findByRole('tab', { name: 'Kubernetes resources' }))
    await user.click(await screen.findByRole('button', { name: /payments-api/ }))

    const modal = await screen.findByRole('dialog')
    expect(within(modal).getByRole('heading', { name: 'payments-api' })).toBeInTheDocument()
    expect(within(modal).getByText('apps/v1')).toBeInTheDocument()
    expect(within(modal).getByRole('button', { name: 'Close' })).toBeInTheDocument()
    expect(within(modal).getAllByRole('button', { name: 'Close' })).toHaveLength(1)
    expect(
      within(modal).getByRole('button', { name: 'Delete resource' }).querySelector('svg'),
    ).not.toBeNull()
    expect(await within(modal).findByLabelText('YAML for payments-api')).toHaveTextContent(
      'kind: Deployment',
    )

    // Deleting from the graph goes through the modal, then the same warning.
    await user.click(within(modal).getByRole('button', { name: 'Delete resource' }))
    expect(
      within(screen.getByRole('alertdialog')).getByText(/recreates it on the next sync/),
    ).toBeInTheDocument()
  })

  it('switches between resource, chart, and timeline tabs', async () => {
    mockAPI({
      applications: [
        buildApplication({
          targets: [
            buildTarget({
              id: 'target-1',
              region: 'us-east-1',
              hasRegionValues: true,
            }),
          ],
        }),
      ],
    })
    renderApp('/applications/onboarding-1')
    const user = userEvent.setup()

    // Target identity stays in the header while operational panels change.
    expect(
      await screen.findByRole('article', { name: 'Deployment target prod-us-east' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Kubernetes resources' })).toHaveAttribute(
      'aria-selected',
      'true',
    )

    await user.click(screen.getByRole('tab', { name: 'Chart & values' }))
    expect(screen.getByText('global-app 1.2.3')).toBeInTheDocument()
    expect(
      screen.getByRole('link', {
        name: 'payments-api/prod/us-east-1/values.yaml ↗',
      }),
    ).toHaveAttribute(
      'href',
      'https://github.com/GitOpsHub/payments-api/blob/commit-1/prod/us-east-1/values.yaml',
    )
    expect(
      screen.getByRole('article', { name: 'Deployment target prod-us-east' }),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Timeline' }))
    expect(screen.getByText('Onboarded')).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Deployment targets' })).not.toBeInTheDocument()
  })

  it('scopes deployment targets by application environment and region', async () => {
    mockAPI({
      applications: [
        buildApplication({
          targets: [
            buildTarget({ id: 'target-1', region: 'us-east-1' }),
            buildTarget({ id: 'target-2', region: 'eu-west-1', clusterName: 'prod-eu' }),
          ],
        }),
      ],
    })
    renderApp('/applications/onboarding-1')
    expect(
      await screen.findByRole('article', { name: 'Deployment target prod-eu' }),
    ).toBeInTheDocument()

    expect(screen.getByText('prod-us-east-1')).toHaveAttribute('aria-current', 'true')
    expect(screen.queryByText('All targets')).not.toBeInTheDocument()
    expect(screen.getByRole('article', { name: 'Deployment target prod-eu' })).toBeInTheDocument()
    expect(
      screen.getByRole('article', { name: 'Deployment target prod-us-east' }),
    ).toBeInTheDocument()
  })

  it('lists every regional release for the selected application', async () => {
    mockAPI({
      applications: [
        buildApplication({
          id: 'onboarding-1',
          name: 'nginx',
          namespace: 'nginx-dev-us-east-1',
          environment: 'dev',
          region: 'us-east-1',
          targets: [
            buildTarget({
              id: 'target-east-1',
              onboardingId: 'onboarding-1',
              clusterName: 'east-cluster',
              region: 'us-east-1',
            }),
          ],
        }),
        buildApplication({
          id: 'onboarding-2',
          name: 'nginx',
          namespace: 'nginx-dev-us-east-2',
          environment: 'dev',
          region: 'us-east-2',
          targets: [
            buildTarget({
              id: 'target-east-2',
              onboardingId: 'onboarding-2',
              clusterName: 'east-2-cluster',
              region: 'us-east-2',
            }),
          ],
        }),
      ],
    })
    renderApp('/applications/onboarding-1')
    const user = userEvent.setup()

    expect(
      await screen.findByRole('button', { name: 'View dev-us-east-1 release' }),
    ).toHaveAttribute('aria-current', 'true')
    expect(
      screen.getByRole('button', { name: 'View dev-us-east-2 release' }),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'View dev-us-east-2 release' }))

    expect(
      await screen.findByRole('button', { name: 'View dev-us-east-2 release' }),
    ).toHaveAttribute('aria-current', 'true')
    expect(
      screen.getByRole('article', { name: 'Deployment target east-2-cluster' }),
    ).toBeInTheDocument()
    expect(screen.getByText('nginx-dev-us-east-2')).toBeInTheDocument()
    expect(
      screen.queryByRole('article', { name: 'Deployment target east-cluster' }),
    ).not.toBeInTheDocument()
  })

  // The proxy authenticates the deep link, so this panel has no reason to hold Argo
  // CD credentials or to offer them to the operator.
  it('exposes no Argo credentials on the deployment targets', async () => {
    const { fetchMock } = mockAPI({ applications: [buildApplication()] })
    renderApp('/applications/onboarding-1')

    expect(
      await screen.findByRole('link', { name: 'Open prod-us-east in Argo CD' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copy password' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Username/)).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('argo-access'))).toBe(false)
  })

  it('omits Argo actions when the target has no UI access', async () => {
    mockAPI({
      applications: [
        buildApplication({
          targets: [buildTarget({ argoApplicationUrl: undefined })],
        }),
      ],
    })
    renderApp('/applications/onboarding-1')

    expect(
      await screen.findByRole('article', { name: 'Deployment target prod-us-east' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /in Argo CD/ })).not.toBeInTheDocument()
  })

  it('shows an empty state when the application has no targets', async () => {
    mockAPI({ applications: [buildApplication({ targets: [] })] })
    renderApp('/applications/onboarding-1')

    expect(await screen.findByText('No clusters assigned')).toBeInTheDocument()
    expect(screen.getByText('No deployment targets')).toBeInTheDocument()
  })

  it('syncs every deployment target from the application detail', async () => {
    const { fetchMock } = mockAPI({
      applications: [buildApplication({ status: 'failed' })],
    })
    renderApp('/applications/onboarding-1')
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: 'Deploy' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/application-onboardings/onboarding-1/sync'),
        expect.objectContaining({ method: 'POST' }),
      )
    })
    expect(
      await screen.findByText('Synchronization started for every deployment target.'),
    ).toBeInTheDocument()
  })

  it('scales application pods through a GitOps replica update', async () => {
    const { fetchMock, state } = mockAPI({
      applications: [buildApplication({ status: 'healthy' })],
    })
    renderApp('/applications/onboarding-1')
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: 'Scale' }))
    expect(screen.getByRole('heading', { name: 'Scale payments-api pods' })).toBeInTheDocument()
    expect(screen.getByText(/committed to GitHub/)).toBeInTheDocument()

    await user.type(screen.getByLabelText('Number of pods'), '5')
    await user.click(screen.getByRole('button', { name: 'Scale pods' }))

    await waitFor(() => {
      expect(state.scaledReplicas).toBe(5)
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/application-onboardings/onboarding-1/scale'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ replicas: 5 }),
        }),
      )
    })
    expect(
      await screen.findByText('Scaling prod-us-east-1 to 5 pods through GitOps.'),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Scale payments-api pods' }),
    ).not.toBeInTheDocument()
  })

  it('offboards cluster resources only after confirmation and preserves GitHub', async () => {
    const { fetchMock } = mockAPI({
      applications: [buildApplication({ status: 'healthy' })],
    })
    renderApp('/applications/onboarding-1')
    const user = userEvent.setup()

    // Offboarding is destructive, so it lives behind the overflow menu rather
    // than beside Deploy.
    await user.click(await screen.findByRole('button', { name: 'More application actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Offboard' }))
    expect(
      screen.getByText(/The GitHub repository and its values will remain available/),
    ).toBeInTheDocument()

    // The confirmation stays disarmed until the application is named back.
    const confirm = screen.getByRole('button', { name: 'Offboard application' })
    expect(confirm).toBeDisabled()
    await user.type(screen.getByRole('textbox'), 'payments-api')
    await user.click(confirm)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/application-onboardings/onboarding-1/offboard'),
        expect.objectContaining({ method: 'POST' }),
      )
    })
    // Nothing is left to operate on, so the application leaves the UI instead of
    // lingering as a dead row on the detail page.
    expect(await screen.findByRole('heading', { name: 'Onboarded applications' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'payments-api' })).not.toBeInTheDocument()
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: /payments-api/ })).not.toBeInTheDocument()
    })
  })

  // The record and its GitHub values are deliberately preserved, so the offboarded
  // filter must still find it along with its re-onboard path.
  it('keeps an offboarded application reachable under the offboarded status', async () => {
    mockAPI({ applications: [buildApplication({ status: 'offboarded' })] })
    renderApp('/applications?status=offboarded')

    expect(await screen.findByRole('link', { name: /payments-api/ })).toBeInTheDocument()
  })

  it('hides offboarded applications from the default list', async () => {
    mockAPI({ applications: [buildApplication({ status: 'offboarded' })] })
    renderApp('/applications')

    expect(await screen.findByRole('heading', { name: 'Onboarded applications' })).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: /payments-api/ })).not.toBeInTheDocument()
    })
  })

  it('polls every five seconds until the deployment reaches a terminal state', async () => {
    // Only the polling interval is faked so React Testing Library keeps using real
    // timers for its own async helpers.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { fetchMock, state } = mockAPI({ applications: [buildApplication()] })
    renderApp('/applications/onboarding-1')

    await screen.findByLabelText('Application sync: Out of Sync')
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
    expect(await screen.findByLabelText('Application sync: Synced')).toBeInTheDocument()
    expect(screen.queryByText(/Every target is synced and healthy./)).not.toBeInTheDocument()
  })

  it('reports a missing application', async () => {
    mockAPI({ applications: [] })
    renderApp('/applications/onboarding-missing')

    expect(await screen.findByText('Application not found')).toBeInTheDocument()
  })

  it('keeps loading and reports the failure when the detail request fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({ error: 'database is unavailable' }, { status: 503 }),
    )
    renderApp('/applications/onboarding-1')

    const state = await screen.findByRole('status')
    expect(state).toHaveTextContent('Loading application…')
    expect(state).toHaveTextContent('database is unavailable')
    expect(within(state).getByRole('button', { name: 'Try again' })).toBeInTheDocument()
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
    expect(screen.queryByLabelText('Namespace')).not.toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Environment'), 'prod')
    await user.selectOptions(screen.getByLabelText('Region'), 'us-east-1')
    const preview = screen.getByRole('table', { name: 'Generated Kubernetes resources' })
    expect(
      within(preview).getByRole('row', {
        name: 'Namespace payments-api-prod-us-east-1',
      }),
    ).toBeInTheDocument()
    for (const [kind, suffix] of [
      ['Deployment', 'deployment'],
      ['Service', 'service'],
      ['ServiceAccount', 'serviceaccount'],
    ]) {
      expect(
        within(preview).getByRole('row', {
          name: `${kind} payments-api-prod-us-east-1-${suffix}`,
        }),
      ).toBeInTheDocument()
    }
    expect(
      within(preview).getByRole('row', {
        name: 'Argo CD Application payments-api-prod-us-east-1',
      }),
    ).toBeInTheDocument()
    expect(
      within(preview).getByRole('row', {
        name: 'GitHub Repository https://github.com/GitOpsHub/payments-api',
      }),
    ).toBeInTheDocument()
    expect(
      within(preview).getByRole('row', { name: 'GitHub Branch main' }),
    ).toBeInTheDocument()
    await user.click(await screen.findByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Onboard' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/application-onboardings'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            name: 'payments-api',
            namespace: 'payments-api',
            environment: 'prod',
            region: 'us-east-1',
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
    expect(screen.getByLabelText('Application sync: Out of Sync')).toBeInTheDocument()
    expect(screen.getByText('registry.example.test/payments-api:2.4.1')).toBeInTheDocument()
    expect(screen.getByText('payments-api-prod-us-east-1')).toBeInTheDocument()
  })

  it('submits the chart defaults without rendering a base values editor', async () => {
    const { fetchMock } = mockAPI()
    renderApp('/applications/new')
    const user = userEvent.setup()

    await screen.findByRole('heading', { name: 'Onboard an application' })
    expect(screen.queryByLabelText('Base Helm values YAML')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: /Base Helm values/ })).not.toBeInTheDocument()

    await user.type(screen.getByLabelText('Application name'), 'payments-api')
    await user.click(await screen.findByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Onboard' }))

    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
      expect(posted).toBeDefined()
      expect(JSON.parse(String(posted?.[1]?.body)).valuesYaml).toBe(
        'replicaCount: 2\nimage:\n  repository: nginx\n',
      )
    })
  })

  it('blocks submission when the chart defaults are unavailable', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (request) => {
      const url = String(request)
      if (url.includes('/application-onboardings/defaults')) {
        return Response.json({ error: 'defaults are not configured' }, { status: 503 })
      }
      if (url.includes('/clusters?')) {
        return Response.json({ items: [], total: 0, page: 1, pageSize: 200 })
      }
      return Response.json({ error: 'not found' }, { status: 404 })
    })
    renderApp('/applications/new')

    expect(await screen.findByRole('alert')).toHaveTextContent('defaults are not configured')
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Onboard' })).toBeDisabled()
    })
  })

  it('keeps the operator on the form when submission fails', async () => {
    mockAPI()
    renderApp('/applications/new')
    const user = userEvent.setup()

    await screen.findByRole('heading', { name: 'Onboard an application' })
    await user.type(screen.getByLabelText('Application name'), 'payments-api')
    await user.click(screen.getByRole('button', { name: 'Onboard' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Select at least one target cluster.',
    )
    expect(screen.getByRole('heading', { name: 'Onboard an application' })).toBeInTheDocument()
  })
})
