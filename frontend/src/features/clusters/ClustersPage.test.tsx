import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderApp } from '../../test/render'
import { buildCluster, mockAPI } from '../../test/mock-api'

function renderClusters() {
  return renderApp('/clusters')
}

function clusterRequests(fetchMock: ReturnType<typeof mockAPI>['fetchMock']) {
  return fetchMock.mock.calls
    .map(([request]) => String(request))
    .filter((url) => url.includes('/clusters?'))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('clusters page', () => {
  it('pages through the inventory at the chosen page size', async () => {
    const { fetchMock } = mockAPI({
      clusters: Array.from({ length: 30 }, (_, index) =>
        buildCluster('active', {
          id: `cluster-${index + 100}`,
          name: `cluster-${String(index).padStart(2, '0')}`,
        }),
      ),
    })
    const user = userEvent.setup()
    renderClusters()

    expect(await screen.findByText('Page 1 of 2 · 30 clusters')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(await screen.findByText('Page 2 of 2 · 30 clusters')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /^cluster-29/ })).toBeInTheDocument()
    expect(clusterRequests(fetchMock).some((url) => url.includes('page=2'))).toBe(true)

    await user.selectOptions(screen.getByRole('combobox', { name: 'Clusters per page' }), '50')
    expect(await screen.findByText('Page 1 of 1 · 30 clusters')).toBeInTheDocument()
  })

  it('offers a way back when filters match nothing', async () => {
    mockAPI()
    const user = userEvent.setup()
    renderClusters()

    await user.type(
      await screen.findByRole('searchbox', { name: 'Search all clusters across providers' }),
      'nothing-here',
    )
    expect(await screen.findByText('Nothing matches those filters')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove name filter nothing-here' }))
    expect(await screen.findByRole('button', { name: /^prod-us-east/ })).toBeInTheDocument()
  })

  it('explains an empty fleet', async () => {
    mockAPI({ clusters: [], sources: [] })
    renderClusters()

    expect(await screen.findByText('No clusters discovered yet')).toBeInTheDocument()
  })

  it('keeps the table on screen and warns when a refresh fails', async () => {
    const { fetchMock } = mockAPI()
    const user = userEvent.setup()
    renderClusters()
    await screen.findByRole('button', { name: /^prod-us-east/ })

    fetchMock.mockImplementation(async () =>
      Response.json({ error: 'database is unavailable' }, { status: 503 }),
    )
    await user.click(screen.getByRole('button', { name: 'AKS, 3 clusters' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('database is unavailable')
    expect(screen.getByRole('button', { name: /^prod-us-east/ })).toBeInTheDocument()
  })

  it('opens the cluster sheet from the row', async () => {
    mockAPI()
    const user = userEvent.setup()
    renderClusters()

    const name = await screen.findByRole('button', { name: /^prod-us-east/ })
    await user.click(within(name.closest('tr') as HTMLElement).getByText('EKS'))
    const sheet = await screen.findByRole('dialog', { name: 'prod-us-east' })
    await user.click(within(sheet).getByRole('button', { name: 'Close cluster details' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})
