import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSyncOptions, syncRequestBody } from '../../api/argo'
import { buildApplication, buildTarget, mockAPI } from '../../test/mock-api'
import { renderApp } from '../../test/render'

afterEach(() => {
  vi.restoreAllMocks()
})

function twoTargets() {
  return buildApplication({
    targets: [
      buildTarget({ id: 'target-1', clusterName: 'prod-us-east' }),
      buildTarget({ id: 'target-2', clusterName: 'prod-eu', region: 'eu-west-1' }),
    ],
  })
}

async function openDialog() {
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Deploy' }))
  const dialog = await screen.findByRole('dialog', { name: 'Sync payments-api' })
  return { user, dialog }
}

describe('sync request body', () => {
  it.each([
    ['defaults on every target send no body', defaultSyncOptions, null],
    [
      'an empty target list still means every target',
      { ...defaultSyncOptions, targetIds: [] },
      null,
    ],
    [
      'a subset names its targets and spells out every option',
      { ...defaultSyncOptions, targetIds: ['target-2'] },
      {
        targetIds: ['target-2'],
        prune: true,
        dryRun: false,
        force: false,
        applyOutOfSyncOnly: false,
      },
    ],
    [
      'turning prune off is a body',
      { ...defaultSyncOptions, prune: false },
      { prune: false, dryRun: false, force: false, applyOutOfSyncOnly: false },
    ],
    [
      'dry run, force, and out-of-sync only',
      { ...defaultSyncOptions, dryRun: true, force: true, applyOutOfSyncOnly: true },
      { prune: true, dryRun: true, force: true, applyOutOfSyncOnly: true },
    ],
  ])('%s', (_, options, expected) => {
    expect(syncRequestBody(options)).toEqual(expected)
  })
})

describe('SyncDialog', () => {
  it('lists every target with its live state and describes the sync in words', async () => {
    mockAPI({ applications: [twoTargets()] })
    renderApp('/applications/onboarding-1')
    const { user, dialog } = await openDialog()

    const east = within(dialog).getByRole('checkbox', { name: /prod-us-east/ })
    const eu = within(dialog).getByRole('checkbox', { name: /prod-eu/ })
    expect(east).toBeChecked()
    expect(eu).toBeChecked()
    expect(within(dialog).getByRole('checkbox', { name: 'Prune' })).toBeChecked()
    expect(within(dialog).getByRole('checkbox', { name: 'Dry run' })).not.toBeChecked()
    expect(within(dialog).getAllByText('Out of Sync').length).toBeGreaterThan(0)
    expect(dialog).toHaveTextContent(
      'Apply the latest commit on main to prod-us-east and prod-eu. Resources removed from Git are deleted.',
    )

    // Force is the one option that can take a workload down, so it says so.
    expect(within(dialog).queryByRole('note')).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('checkbox', { name: 'Force' }))
    expect(within(dialog).getByRole('note')).toHaveTextContent(/briefly go unavailable/)

    // With nothing ticked there is nothing to start.
    await user.click(east)
    await user.click(eu)
    expect(within(dialog).getByRole('button', { name: 'Start sync' })).toBeDisabled()
    expect(dialog).toHaveTextContent('Choose at least one cluster to sync.')
  })

  it('sends the chosen options and targets as the request body', async () => {
    const { fetchMock, state } = mockAPI({ applications: [twoTargets()] })
    renderApp('/applications/onboarding-1')
    const { user, dialog } = await openDialog()

    await user.click(within(dialog).getByRole('checkbox', { name: /prod-us-east/ }))
    await user.click(within(dialog).getByRole('checkbox', { name: 'Prune' }))
    await user.click(within(dialog).getByRole('checkbox', { name: 'Apply out-of-sync only' }))
    expect(dialog).toHaveTextContent(
      'Resources removed from Git are left in place, unless the automated sync policy prunes them.',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Start sync' }))

    await waitFor(() => expect(state.syncRequests).toHaveLength(1))
    expect(state.syncRequests[0]).toEqual({
      targetIds: ['target-2'],
      prune: false,
      dryRun: false,
      force: false,
      applyOutOfSyncOnly: true,
    })
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/sync'))
    expect(call?.[1]).toMatchObject({ headers: { 'Content-Type': 'application/json' } })
    expect(await screen.findByText('Synchronization started for prod-eu.')).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Sync payments-api' })).not.toBeInTheDocument()
  })

  it('keeps the default sync bodiless', async () => {
    const { fetchMock, state } = mockAPI({ applications: [twoTargets()] })
    renderApp('/applications/onboarding-1')
    const { user, dialog } = await openDialog()
    await user.click(within(dialog).getByRole('button', { name: 'Start sync' }))

    await waitFor(() => expect(state.syncRequests).toEqual([null]))
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/sync'))
    expect(call?.[1]).toEqual({ method: 'POST' })
  })

  it('starts a dry run and says where its results will appear', async () => {
    const { state } = mockAPI({ applications: [twoTargets()] })
    renderApp('/applications/onboarding-1')
    const { user, dialog } = await openDialog()

    await user.click(within(dialog).getByRole('checkbox', { name: 'Dry run' }))
    expect(dialog).toHaveTextContent(
      /Preview a sync of prod-us-east and prod-eu.*Nothing on the cluster changes/,
    )
    await user.click(within(dialog).getByRole('button', { name: 'Start dry run' }))

    await waitFor(() => expect(state.syncRequests).toHaveLength(1))
    expect(state.syncRequests[0]).toMatchObject({ dryRun: true, prune: true })
    expect(await screen.findByText('Dry run started on prod-us-east, prod-eu.')).toBeInTheDocument()
    expect(
      screen.getByText('Its results appear in the Sync tab once Argo CD finishes.'),
    ).toBeInTheDocument()
    // Nothing changed, so the record is not marked as progressing.
    expect(state.applications[0].status).toBe('progressing')
    expect(screen.getByLabelText('Application sync: Out of Sync')).toBeInTheDocument()
  })
})
