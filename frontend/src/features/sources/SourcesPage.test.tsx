import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../../App'
import { buildSource, buildSyncRun, mockAPI } from '../../test/mock-api'

function renderSources() {
  return render(
    <MemoryRouter initialEntries={['/sources']}>
      <App />
    </MemoryRouter>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('cloud sources page', () => {
  it('lists each source with its latest run and last error', async () => {
    mockAPI({
      sources: [
        buildSource(),
        buildSource({
          id: 'gcp-platform',
          provider: 'gcp',
          name: 'Google Cloud Platform',
          lastSyncStatus: 'failed',
          lastSyncError: 'permission denied on project',
        }),
        buildSource({ id: 'azure-off', provider: 'azure', name: 'Azure Lab', enabled: false }),
      ],
      syncRuns: [buildSyncRun({ discoveredCount: 4 })],
    })
    renderSources()

    const aws = await screen.findByRole('listitem', { name: 'AWS Platform' })
    expect(within(aws).getByText('succeeded')).toBeInTheDocument()
    expect(within(aws).getByText(/last run scheduled, 4 clusters/)).toBeInTheDocument()

    const gcp = screen.getByRole('listitem', { name: 'Google Cloud Platform' })
    expect(within(gcp).getByText('failed')).toBeInTheDocument()
    expect(within(gcp).getByText('permission denied on project')).toBeInTheDocument()

    // A disabled source cannot be synced.
    const azure = screen.getByRole('listitem', { name: 'Azure Lab' })
    expect(within(azure).getByRole('button', { name: 'Sync now' })).toBeDisabled()
  })

  it('queues a sync and refreshes the run list and the sidebar', async () => {
    const { state } = mockAPI()
    const user = userEvent.setup()
    renderSources()

    const aws = await screen.findByRole('listitem', { name: 'AWS Platform' })
    await user.click(within(aws).getByRole('button', { name: 'Sync now' }))

    await waitFor(() => expect(state.syncedSources).toEqual(['aws-platform']))
    const runs = screen.getByRole('region', { name: 'Recent sync runs' })
    expect(await within(runs).findByText('queued')).toBeInTheDocument()
    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' })
    expect(await within(sidebar).findByText('Sync queued')).toBeInTheDocument()
  })

  it('reports a sync that could not be started', async () => {
    mockAPI({ syncError: 'a sync is already running for this source' })
    const user = userEvent.setup()
    renderSources()

    const aws = await screen.findByRole('listitem', { name: 'AWS Platform' })
    await user.click(within(aws).getByRole('button', { name: 'Sync now' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('a sync is already running')
  })

  it('explains where sources come from when there are none', async () => {
    mockAPI({ sources: [], syncRuns: [] })
    renderSources()

    expect(await screen.findByText('No cloud sources configured')).toBeInTheDocument()
  })
})
