import { act, renderHook, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import {
  buildApplication,
  buildArgoStatus,
  buildEvent,
  buildOperation,
  buildResource,
  buildRevision,
  buildTarget,
  mockAPI,
} from '../../test/mock-api'
import { renderApp } from '../../test/render'
import { applicationTabHref } from './detail-links'
import { useChangeFlash } from './useChangeFlash'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('application detail page', () => {
  it('identifies the release by where it runs and orders its actions', async () => {
    mockAPI({ applications: [buildApplication()] })
    const { container } = renderApp('/applications/onboarding-1')

    const heading = await screen.findByRole('heading', { level: 1, name: 'payments-api' })
    // The mark is the first target's provider (EKS here), not a fixed logo.
    expect(container.querySelector('.detail-mark .target-logo')).not.toBeNull()
    expect(screen.getByTitle('Kubernetes namespace')).toHaveTextContent('ns/payments')
    expect(screen.getByTitle('Region')).toHaveTextContent('us-east-1')
    expect(heading).toBeInTheDocument()

    const actions = screen.getByRole('group', { name: 'Application actions' })
    const order = [
      within(actions).getByLabelText('Application sync: Out of Sync'),
      within(actions).getByRole('button', { name: 'Manifest' }),
      within(actions).getByRole('button', { name: 'Deploy' }),
      within(actions).getByRole('button', { name: 'Scale' }),
      within(actions).getByRole('button', { name: 'More application actions' }),
    ]
    for (let index = 1; index < order.length; index++) {
      expect(
        order[index - 1].compareDocumentPosition(order[index]) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
    }
  })

  it('links each target card to its logs and keeps the Argo CD link', async () => {
    mockAPI({
      applications: [
        buildApplication({
          targets: [
            buildTarget({ id: 'target-1', clusterName: 'prod-us-east' }),
            buildTarget({ id: 'target-2', clusterName: 'prod-eu', region: 'eu-west-1' }),
          ],
        }),
      ],
    })
    renderApp('/applications/onboarding-1')

    const eu = await screen.findByRole('article', { name: 'Deployment target prod-eu' })
    expect(within(eu).getByRole('link', { name: 'Logs for prod-eu' })).toHaveAttribute(
      'href',
      '/applications/onboarding-1/logs?target=target-2',
    )
    expect(within(eu).getByRole('link', { name: 'Open prod-eu in Argo CD' })).toBeInTheDocument()
  })

  it('keeps the tab and the cluster in the URL across every per-target tab', async () => {
    mockAPI({
      applications: [
        buildApplication({
          targets: [
            buildTarget({ id: 'target-1', clusterName: 'prod-us-east' }),
            buildTarget({ id: 'target-2', clusterName: 'prod-eu', region: 'eu-west-1' }),
          ],
        }),
      ],
      resources: [buildResource({ uid: 'uid-dep', kind: 'Deployment', name: 'payments-api' })],
    })
    renderApp(applicationTabHref('onboarding-1', 'logs', { target: 'target-2' }))
    const user = userEvent.setup()

    const tabs = await screen.findAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Kubernetes resources',
      'Sync',
      'Logs',
      'Events',
      'History',
      'Chart & values',
      'Timeline',
    ])
    expect(screen.getByRole('tab', { name: 'Logs' })).toHaveAttribute('aria-selected', 'true')
    const clusters = screen.getByRole('group', { name: 'Choose a cluster' })
    expect(within(clusters).getByRole('button', { name: /prod-eu/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    // The main Deployment streams by default.
    const logs = await screen.findByLabelText('Live logs for payments-api')
    expect(logs).toHaveTextContent('server started on :8080')
    expect(screen.getByRole('link', { name: 'Full screen' })).toHaveAttribute(
      'href',
      '/applications/onboarding-1/logs?target=target-2&kind=Deployment&name=payments-api&namespace=payments',
    )

    // The cluster choice survives a tab change.
    await user.click(screen.getByRole('tab', { name: 'Sync' }))
    expect(await screen.findByText('No sync has run on prod-eu yet')).toBeInTheDocument()
    expect(
      within(screen.getByRole('group', { name: 'Choose a cluster' })).getByRole('button', {
        name: /prod-eu/,
      }),
    ).toHaveAttribute('aria-pressed', 'true')
  })

  it('opens the Sync tab from the operation strip', async () => {
    const target = buildTarget()
    mockAPI({
      applications: [buildApplication({ targets: [target] })],
      argoStatuses: {
        'target-1': buildArgoStatus(target, { operation: buildOperation({ phase: 'Running' }) }),
      },
    })
    renderApp('/applications/onboarding-1?tab=chart')
    const user = userEvent.setup()

    const strip = await screen.findByRole('region', { name: 'Sync in progress' })
    expect(strip).toHaveTextContent(/Syncing prod-us-east·Queued phase·\d+:\d\d/)
    await user.click(within(strip).getByRole('button'))
    expect(screen.getByRole('tab', { name: 'Sync' })).toHaveAttribute('aria-selected', 'true')
    expect(
      await screen.findByRole('heading', { name: 'Sync operation on prod-us-east' }),
    ).toBeInTheDocument()
  })

  it('merges audit, commits, deploys, and warnings into the timeline', async () => {
    const target = buildTarget()
    const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
    mockAPI({
      applications: [buildApplication({ targets: [target], createdAt: at(600) })],
      operations: [
        {
          id: 'op-1',
          onboardingId: 'onboarding-1',
          targetId: null,
          kind: 'rollback',
          params: { commitSha: 'aaa1111aaaa0000', valuesCommitSha: 'ddd4444aaaa0000' },
          result: 'succeeded',
          createdAt: at(5),
        },
        {
          id: 'op-2',
          onboardingId: 'onboarding-1',
          targetId: null,
          kind: 'sync',
          params: {
            prune: false,
            force: false,
            applyOutOfSyncOnly: false,
            targetIds: ['target-1'],
          },
          result: 'succeeded',
          createdAt: at(30),
        },
      ],
      revisions: [
        buildRevision({
          sha: 'ddd4444aaaa0000',
          message: 'Roll back prod/us-east-1 values to aaa1111',
          committedAt: at(5),
          current: true,
        }),
      ],
      argoStatuses: {
        'target-1': buildArgoStatus(target, {
          history: [
            {
              id: 3,
              revisions: ['1.2.3', 'ddd4444aaaa0000'],
              deployStartedAt: at(4),
              deployedAt: at(4),
              initiatedBy: { automated: true },
            },
          ],
        }),
      },
      targetEvents: {
        'target-1': [
          buildEvent({
            type: 'Warning',
            reason: 'SyncError',
            message: 'hook failed',
            lastSeen: at(20),
          }),
          buildEvent({ reason: 'ResourceUpdated', lastSeen: at(21) }),
        ],
      },
    })
    renderApp('/applications/onboarding-1?tab=timeline')

    expect(await screen.findByText('Values rolled back to aaa1111')).toBeInTheDocument()
    expect(screen.getByText('Sync requested')).toBeInTheDocument()
    expect(screen.getByText('prod-us-east · no prune')).toBeInTheDocument()
    expect(screen.getAllByText('via KubeOps')).toHaveLength(2)
    expect(screen.getByText('Roll back prod/us-east-1 values to aaa1111')).toBeInTheDocument()
    expect(screen.getByText('Deployed to prod-us-east')).toBeInTheDocument()
    expect(screen.getByText('values ddd4444 · chart 1.2.3')).toBeInTheDocument()
    expect(screen.getByText('SyncError on prod-us-east')).toBeInTheDocument()
    // Normal events stay in the Events tab; the timeline carries warnings.
    expect(screen.queryByText(/ResourceUpdated/)).not.toBeInTheDocument()
    expect(screen.getByText('Onboarded')).toBeInTheDocument()
  })

  it('has no detectable accessibility violations on any tab', async () => {
    const target = buildTarget()
    mockAPI({
      applications: [buildApplication({ targets: [target] })],
      resources: [buildResource({ uid: 'uid-dep', kind: 'Deployment', name: 'payments-api' })],
      argoStatuses: {
        'target-1': buildArgoStatus(target, {
          operation: buildOperation({
            phase: 'Running',
            resources: [
              {
                group: 'apps',
                version: 'v1',
                kind: 'Deployment',
                namespace: 'payments',
                name: 'payments-api',
                status: 'Synced',
                syncPhase: 'Sync',
              },
            ],
          }),
        }),
      },
      targetEvents: { 'target-1': [buildEvent({ type: 'Warning', reason: 'BackOff' })] },
      revisions: [buildRevision({ current: true }), buildRevision({ sha: 'bbb2222aaaa0000' })],
    })
    const { container } = renderApp('/applications/onboarding-1')
    const user = userEvent.setup()
    await screen.findByRole('region', { name: 'Sync in progress' })

    const ready: Record<string, () => Promise<unknown>> = {
      'Kubernetes resources': () =>
        screen.findByRole('button', { name: 'Actions for Deployment payments-api' }),
      Sync: () => screen.findByRole('heading', { name: 'Sync operation on prod-us-east' }),
      Logs: () => screen.findByText('GET /health 200'),
      Events: () => screen.findByRole('region', { name: 'Pod payments-api-abc' }),
      History: () => screen.findByRole('list', { name: 'Values revisions' }),
      'Chart & values': () => screen.findByText('global-app 1.2.3'),
      Timeline: () => screen.findByText('Onboarded'),
    }
    for (const [tab, loaded] of Object.entries(ready)) {
      await user.click(screen.getByRole('tab', { name: tab }))
      await loaded()
      expect(await axe(container), tab).toHaveNoViolations()
    }
  })
})

describe('useChangeFlash', () => {
  it('flashes when the value changes, never on first render', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ value }) => useChangeFlash(value), {
      initialProps: { value: 'Progressing' },
    })
    expect(result.current).toBe(false)
    rerender({ value: 'Progressing' })
    expect(result.current).toBe(false)

    rerender({ value: 'Healthy' })
    expect(result.current).toBe(true)
    act(() => vi.advanceTimersByTime(600))
    expect(result.current).toBe(false)
  })
})
