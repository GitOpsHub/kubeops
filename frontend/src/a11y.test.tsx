import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { themeStorageKey } from './hooks/useTheme'
import {
  buildApplication,
  buildArgoStatus,
  buildCluster,
  buildEvent,
  buildOperation,
  buildResource,
  buildRevision,
  buildTarget,
  mockAPI,
} from './test/mock-api'
import { renderApp } from './test/render'

/**
 * Every route, in both themes, through axe. jsdom has no layout or computed
 * colour, so contrast is left to tokens.contrast.test.ts; everything else axe
 * checks — names, roles, landmarks, ARIA wiring, duplicate ids — runs here on
 * the whole document, portals included.
 */
const options = { rules: { 'color-contrast': { enabled: false } } }

async function expectNoViolations(context: string) {
  expect(await axe(document.body, options), context).toHaveNoViolations()
}

const stored = new Map<string, string>()

beforeEach(() => {
  stored.clear()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
    clear: () => stored.clear(),
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  delete document.documentElement.dataset.theme
})

const target = buildTarget()
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
]

function mockFleet() {
  return mockAPI({
    applications: [
      buildApplication({ targets: [target] }),
      buildApplication({
        id: 'onboarding-2',
        name: 'ledger',
        status: 'failed',
        targets: [buildTarget({ id: 'target-2', onboardingId: 'onboarding-2' })],
      }),
    ],
    clusters: [
      buildCluster('active'),
      buildCluster('degraded', { id: 'cluster-2', name: 'prod-eu', location: 'eu-west-1' }),
    ],
    resources,
    argoStatuses: {
      'target-1': buildArgoStatus(target, {
        operation: buildOperation({ phase: 'Running' }),
      }),
    },
    targetEvents: { 'target-1': [buildEvent({ type: 'Warning', reason: 'BackOff' })] },
    revisions: [buildRevision({ current: true }), buildRevision({ sha: 'bbb2222aaaa0000' })],
  })
}

describe.each(['light', 'dark'] as const)('accessibility in the %s theme', (theme) => {
  beforeEach(() => {
    stored.set(themeStorageKey, theme)
    mockFleet()
  })

  async function open(route: string, ready: () => Promise<unknown>) {
    renderApp(route)
    await ready()
    expect(document.documentElement.dataset.theme).toBe(theme)
  }

  it('overview', async () => {
    await open('/', () => screen.findByRole('region', { name: 'Needs attention' }))
    await expectNoViolations('/')
  })

  it('clusters', async () => {
    await open('/clusters', () => screen.findByRole('button', { name: /prod-eu/ }))
    await expectNoViolations('/clusters')
  })

  it('cluster detail sheet', async () => {
    await open('/clusters', () => screen.findByRole('button', { name: /prod-eu/ }))
    await userEvent.setup().click(screen.getByRole('button', { name: /prod-eu/ }))
    await screen.findByRole('dialog')
    await screen.findByText(/Open this cluster in Argo CD|Argo CD access is unavailable/)
    await expectNoViolations('/clusters sheet')
  })

  it('sources', async () => {
    await open('/sources', () => screen.findByText('Google Cloud Platform'))
    await expectNoViolations('/sources')
  })

  it('applications as tiles', async () => {
    await open('/applications', () => screen.findByRole('link', { name: 'ledger' }))
    await expectNoViolations('/applications tiles')
  })

  it('applications as a table, expanded', async () => {
    stored.set('kubeops.applications.view', 'table')
    await open('/applications', () => screen.findByRole('link', { name: 'ledger' }))
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Show deployment targets for payments-api' }))
    await screen.findByRole('link', { name: 'Open prod-us-east in Argo CD' })
    await expectNoViolations('/applications table')
  })

  it('every onboarding step', async () => {
    await open('/applications/new', () =>
      screen.findByRole('heading', { name: 'Onboard an application' }),
    )
    const user = userEvent.setup()
    const next = () => user.click(screen.getByRole('button', { name: 'Next' }))

    // An empty submit shows the field errors, which must be wired correctly too.
    await next()
    expect(await screen.findByLabelText('Application name')).toHaveAttribute('aria-invalid', 'true')
    await expectNoViolations('onboarding: application errors')

    await user.type(screen.getByLabelText('Application name'), 'payments-api')
    await next()
    await expectNoViolations('onboarding: scope')
    await next()
    await screen.findByRole('heading', { name: 'Pick target clusters' })
    await user.click(await screen.findByRole('checkbox', { name: 'Select prod-us-east' }))
    await expectNoViolations('onboarding: targets')
    await next()
    await expectNoViolations('onboarding: values')
    await next()
    await screen.findByRole('heading', { name: 'Review and onboard' })
    await expectNoViolations('onboarding: review')
  })

  it('application detail, every tab', async () => {
    await open('/applications/onboarding-1', () =>
      screen.findByRole('region', { name: 'Sync in progress' }),
    )
    const user = userEvent.setup()
    const tabs: Record<string, () => Promise<unknown>> = {
      'Kubernetes resources': () =>
        screen.findByRole('button', { name: 'Actions for Deployment payments-api' }),
      Sync: () => screen.findByRole('heading', { name: 'Sync operation on prod-us-east' }),
      Logs: () => screen.findByText('GET /health 200'),
      Events: () => screen.findByText(/BackOff/),
      History: () => screen.findByRole('list', { name: 'Values revisions' }),
      'Chart & values': () => screen.findByText('global-app 1.2.3'),
      Timeline: () => screen.findByText('Onboarded'),
    }
    for (const [tab, ready] of Object.entries(tabs)) {
      await user.click(screen.getByRole('tab', { name: tab }))
      await ready()
      await expectNoViolations(`detail: ${tab}`)
    }
  })

  it('full-page logs', async () => {
    await open(
      '/applications/onboarding-1/logs?target=target-1&kind=Pod&name=payments-api-abc&namespace=payments',
      () => screen.findByText('GET /health 200'),
    )
    await expectNoViolations('logs')
  })

  it('not found', async () => {
    await open('/no-such-page', () =>
      screen.findByRole('heading', { level: 1, name: 'Page not found' }),
    )
    await expectNoViolations('404')
  })
})
