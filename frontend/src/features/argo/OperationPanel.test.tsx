import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArgoOperationResource } from '../../api/argo'
import {
  buildApplication,
  buildArgoStatus,
  buildOperation,
  buildTarget,
  mockAPI,
} from '../../test/mock-api'
import { renderApp } from '../../test/render'

afterEach(() => {
  vi.restoreAllMocks()
})

function resource(overrides: Partial<ArgoOperationResource>): ArgoOperationResource {
  return {
    group: 'apps',
    version: 'v1',
    kind: 'Deployment',
    namespace: 'payments',
    name: 'payments-api',
    status: 'Synced',
    syncPhase: 'Sync',
    ...overrides,
  }
}

const hookResources = [
  resource({
    group: 'batch',
    kind: 'Job',
    name: 'migrate',
    hookType: 'PreSync',
    hookPhase: 'Succeeded',
    syncPhase: 'PreSync',
  }),
  resource({}),
  resource({
    group: 'batch',
    kind: 'Job',
    name: 'smoke-test',
    hookType: 'PostSync',
    hookPhase: 'Running',
    syncPhase: 'PostSync',
    message: 'job is still running',
  }),
]

function steps() {
  const stepper = screen.getByRole('list', { name: 'Sync progress' })
  return within(stepper)
    .getAllByRole('listitem')
    .map((item) => `${item.textContent}${item.getAttribute('aria-current') ? ' [current]' : ''}`)
}

describe('OperationPanel', () => {
  it('shows a running sync phase by phase and terminates it on confirmation', async () => {
    const target = buildTarget()
    const { state } = mockAPI({
      applications: [buildApplication({ targets: [target] })],
      argoStatuses: {
        'target-1': buildArgoStatus(target, {
          operation: buildOperation({ phase: 'Running', resources: hookResources }),
        }),
      },
    })
    renderApp('/applications/onboarding-1?tab=sync')
    const user = userEvent.setup()

    expect(await screen.findByRole('tab', { name: 'Sync' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(
      await screen.findByRole('heading', { name: 'Sync operation on prod-us-east' }),
    ).toBeInTheDocument()
    expect(steps()).toEqual([
      'Queued, done',
      'PreSync1 hook, done',
      'Sync1 resource, done',
      'PostSync1 hook, in progress [current]',
      'Complete, not started',
    ])
    expect(screen.getByText('kubeops')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'abc1234 ↗' })).toHaveAttribute(
      'href',
      'https://github.com/GitOpsHub/payments-api/commit/abc1234def5678',
    )
    const results = screen.getByRole('table', { name: 'Sync results on prod-us-east' })
    expect(within(results).getAllByRole('row')).toHaveLength(4)
    expect(within(results).getByText('job is still running')).toBeInTheDocument()

    // The strip and the target card both say a sync is running, from any tab.
    expect(
      within(screen.getByRole('region', { name: 'Sync in progress' })).getByRole('button', {
        name: 'Syncing prod-us-east. View sync progress',
      }),
    ).toBeInTheDocument()
    expect(
      within(screen.getByRole('article', { name: 'Deployment target prod-us-east' })).getByRole(
        'button',
        { name: 'Sync running on prod-us-east: PostSync phase. View progress' },
      ),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Terminate' }))
    const confirm = screen.getByRole('alertdialog', { name: 'Terminate the sync on prod-us-east?' })
    await user.click(within(confirm).getByRole('button', { name: 'Terminate sync' }))

    await waitFor(() => expect(state.terminatedTargets).toEqual(['target-1']))
    expect(await screen.findByText('Terminating the sync on prod-us-east.')).toBeInTheDocument()
    expect(
      screen.queryByRole('alertdialog', { name: 'Terminate the sync on prod-us-east?' }),
    ).not.toBeInTheDocument()
  })

  it('pinpoints a failure, filters to it, retries the target, and opens its logs', async () => {
    const target = buildTarget()
    const { state } = mockAPI({
      applications: [buildApplication({ targets: [target] })],
      argoStatuses: {
        'target-1': buildArgoStatus(target, {
          operation: buildOperation({
            phase: 'Failed',
            message: 'one or more objects failed to apply',
            finishedAt: new Date().toISOString(),
            resources: [
              resource({ status: 'SyncFailed', message: 'admission webhook denied the request' }),
              resource({ group: '', kind: 'Service', name: 'payments-api' }),
            ],
          }),
          conditions: [
            {
              type: 'SyncError',
              message: 'Failed sync attempt: one or more objects failed to apply',
              lastTransitionTime: null,
            },
          ],
          images: ['registry.example.test/payments-api:2.5.0'],
        }),
      },
    })
    renderApp('/applications/onboarding-1?tab=sync')
    const user = userEvent.setup()

    await screen.findByRole('heading', { name: 'Sync operation on prod-us-east' })
    expect(steps()).toEqual([
      'Queued, done',
      'PreSyncNo hooks, skipped',
      'Sync2 resources, failed',
      'PostSync, not started',
      'Failed, failed',
    ])
    expect(screen.getByText('one or more objects failed to apply')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Conditions' })).toHaveTextContent('SyncError')
    expect(screen.getByRole('region', { name: 'Images' })).toHaveTextContent(
      'registry.example.test/payments-api:2.5.0',
    )
    expect(screen.queryByRole('button', { name: 'Terminate' })).not.toBeInTheDocument()

    const results = screen.getByRole('table', { name: 'Sync results on prod-us-east' })
    expect(within(results).getAllByRole('row')).toHaveLength(3)
    await user.click(screen.getByRole('switch', { name: 'Failed only' }))
    expect(within(results).getAllByRole('row')).toHaveLength(2)
    expect(within(results).getByText('Sync failed')).toBeInTheDocument()
    expect(within(results).getByText('admission webhook denied the request')).toBeInTheDocument()

    await user.click(
      within(results).getByRole('button', { name: 'View logs for Deployment payments-api' }),
    )
    expect(await screen.findByLabelText('Live logs for payments-api')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close' }))

    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(state.syncRequests).toHaveLength(1))
    expect(state.syncRequests[0]).toEqual({
      targetIds: ['target-1'],
      prune: true,
      dryRun: false,
      force: false,
      applyOutOfSyncOnly: false,
    })
    expect(
      await screen.findByText('Synchronization started for every deployment target.'),
    ).toBeInTheDocument()
  })

  it('hides Terminate when the server turns console mutations off', async () => {
    const target = buildTarget()
    mockAPI({
      consoleMutations: false,
      applications: [buildApplication({ targets: [target] })],
      argoStatuses: {
        'target-1': buildArgoStatus(target, {
          operation: buildOperation({ phase: 'Running', resources: hookResources }),
        }),
      },
    })
    renderApp('/applications/onboarding-1?tab=sync')

    await screen.findByRole('heading', { name: 'Sync operation on prod-us-east' })
    // Capabilities arrive separately from the status, so wait for them.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Terminate' })).not.toBeInTheDocument(),
    )
  })

  it('offers a first sync of just this cluster when none has run', async () => {
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
    renderApp('/applications/onboarding-1?tab=sync&target=target-2')
    const user = userEvent.setup()

    expect(await screen.findByText('No sync has run on prod-eu yet')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Sync prod-eu' }))
    const dialog = await screen.findByRole('dialog', { name: 'Sync payments-api' })
    expect(within(dialog).getByRole('checkbox', { name: /prod-eu/ })).toBeChecked()
    expect(within(dialog).getByRole('checkbox', { name: /prod-us-east/ })).not.toBeChecked()
  })

  it('announces how a running sync ended', async () => {
    const target = buildTarget()
    const { state } = mockAPI({
      applications: [buildApplication({ targets: [target] })],
      argoStatuses: {
        'target-1': buildArgoStatus(target, {
          operation: buildOperation({ phase: 'Running', resources: hookResources }),
        }),
      },
    })
    renderApp('/applications/onboarding-1')
    await screen.findByRole('region', { name: 'Sync in progress' })

    state.argoStatuses['target-1'] = buildArgoStatus(target, {
      operation: buildOperation({ phase: 'Succeeded', finishedAt: new Date().toISOString() }),
    })
    // A running operation is polled every 1.5 seconds.
    expect(
      await screen.findByText('Sync succeeded on prod-us-east.', {}, { timeout: 4_000 }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Sync in progress' })).not.toBeInTheDocument()
  })
})
