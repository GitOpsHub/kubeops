import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderApp } from '../../test/render'
import { buildCluster, mockAPI } from '../../test/mock-api'
import { inventoryStatus, nextSort } from './cluster-filters'

function clusterRequests(fetchMock: ReturnType<typeof mockAPI>['fetchMock']) {
  return fetchMock.mock.calls
    .map(([request]) => new URL(String(request), 'http://localhost'))
    .filter((url) => url.pathname.endsWith('/clusters'))
}

function lastClusterRequest(fetchMock: ReturnType<typeof mockAPI>['fetchMock']) {
  return clusterRequests(fetchMock).at(-1)!.searchParams
}

const fleet = [
  buildCluster('active', { id: 'a', name: 'alpha', nodeCount: 9 }),
  buildCluster('degraded', { id: 'b', name: 'bravo', nodeCount: 3 }),
  buildCluster('active', {
    id: 'c',
    name: 'charlie',
    nodeCount: null,
    provider: 'azure',
    sourceId: 'azure-platform',
    sourceName: 'Azure Platform',
  }),
  buildCluster('active', { id: 'd', name: 'delta', removedAt: new Date().toISOString() }),
]

function rowNames() {
  const table = screen.getByRole('table', { name: 'Clusters' })
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map(
      (row) =>
        within(row)
          .getAllByRole('button')[0]
          .textContent?.match(/^[a-z]+/)?.[0],
    )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('cluster filters', () => {
  it('sorts through the API from the column headers', async () => {
    const { fetchMock } = mockAPI({ clusters: fleet })
    const user = userEvent.setup()
    renderApp('/clusters')
    await screen.findByRole('button', { name: /^alpha/ })
    expect(lastClusterRequest(fetchMock).has('sort')).toBe(false)

    await user.click(screen.getByRole('button', { name: 'Nodes' }))
    await waitFor(() => expect(lastClusterRequest(fetchMock).get('sort')).toBe('nodes'))
    expect(lastClusterRequest(fetchMock).get('order')).toBe('asc')
    await waitFor(() => expect(rowNames()).toEqual(['bravo', 'alpha', 'charlie']))
    expect(screen.getByRole('columnheader', { name: 'Nodes' })).toHaveAttribute(
      'aria-sort',
      'ascending',
    )

    await user.click(screen.getByRole('button', { name: 'Nodes' }))
    await waitFor(() => expect(lastClusterRequest(fetchMock).get('order')).toBe('desc'))
    // NULLs stay last whichever way the column runs.
    await waitFor(() => expect(rowNames()).toEqual(['alpha', 'bravo', 'charlie']))
  })

  it('opens "last seen" newest first and flips any column on a second click', () => {
    expect(nextSort('', 'asc', 'lastSeen')).toEqual({ sort: 'lastSeen', order: 'desc' })
    expect(nextSort('', 'asc', 'name')).toEqual({ sort: 'name', order: 'asc' })
    expect(nextSort('name', 'asc', 'name')).toEqual({ sort: 'name', order: 'desc' })
    expect(nextSort('name', 'desc', 'nodes')).toEqual({ sort: 'nodes', order: 'asc' })
  })

  it('applies an attention link’s filters from the URL', async () => {
    const { fetchMock } = mockAPI({ clusters: fleet })
    renderApp('/clusters?search=bra&source=aws-platform&status=degraded&sort=name&order=desc')

    expect(await screen.findByRole('button', { name: /^bravo/ })).toBeInTheDocument()
    const params = lastClusterRequest(fetchMock)
    expect(params.get('search')).toBe('bra')
    expect(params.get('source')).toBe('aws-platform')
    expect(params.get('status')).toBe('degraded')
    expect(params.get('sort')).toBe('name')
    expect(params.get('order')).toBe('desc')
    expect(
      screen.getByRole('searchbox', { name: 'Search all clusters across providers' }),
    ).toHaveValue('bra')
    expect(screen.getByRole('button', { name: /^Source AWS Platform/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Status Degraded/ })).toBeInTheDocument()
    // A degraded cluster keeps its provider's word in the health column.
    const row = screen.getByRole('button', { name: /^bravo/ }).closest('tr')!
    expect(within(row).getByText('degraded')).toBeInTheDocument()
  })

  it('opens a command-palette link with the name in the global search', async () => {
    const { fetchMock } = mockAPI({ clusters: fleet })
    renderApp('/clusters?search=charlie')

    expect(await screen.findByRole('button', { name: /^charlie/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^alpha/ })).not.toBeInTheDocument()
    expect(
      screen.getByRole('searchbox', { name: 'Search all clusters across providers' }),
    ).toHaveValue('charlie')
    expect(screen.getByRole('button', { name: 'All, 6 clusters' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(clusterRequests(fetchMock).every((url) => !url.searchParams.has('provider'))).toBe(true)
  })

  it('filters by source from a menu, not a select', async () => {
    const { fetchMock } = mockAPI({ clusters: fleet })
    const user = userEvent.setup()
    renderApp('/clusters')
    await screen.findByRole('button', { name: /^alpha/ })
    expect(screen.queryByRole('combobox', { name: 'Source' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^Source All sources/ }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'Azure Platform' }))

    await waitFor(() => expect(lastClusterRequest(fetchMock).get('source')).toBe('azure-platform'))
    expect(await screen.findByRole('button', { name: /^charlie/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^alpha/ })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Reset filters' }))
    await waitFor(() => expect(lastClusterRequest(fetchMock).has('source')).toBe(false))
    expect(await screen.findByRole('button', { name: /^alpha/ })).toBeInTheDocument()
  })

  it('filters by status and shows removed clusters on request', async () => {
    const { fetchMock } = mockAPI({ clusters: fleet })
    const user = userEvent.setup()
    renderApp('/clusters')
    await screen.findByRole('button', { name: /^alpha/ })
    expect(screen.queryByRole('button', { name: /^delta/ })).not.toBeInTheDocument()

    await user.click(screen.getByRole('switch', { name: 'Show removed' }))
    await waitFor(() => expect(lastClusterRequest(fetchMock).get('includeRemoved')).toBe('true'))
    const removed = (await screen.findByRole('button', { name: /^delta/ })).closest('tr')!
    expect(within(removed).getByText('removed')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^Status Any status/ }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'Degraded' }))
    await waitFor(() => expect(lastClusterRequest(fetchMock).get('status')).toBe('degraded'))
    await waitFor(() => expect(rowNames()).toEqual(['bravo']))
  })

  it('drops a source filter when switching to another provider', async () => {
    const { fetchMock } = mockAPI({ clusters: fleet })
    const user = userEvent.setup()
    renderApp('/clusters?source=aws-platform')
    await screen.findByRole('button', { name: /^alpha/ })

    await user.click(screen.getByRole('button', { name: 'EKS, 1 cluster' }))
    await waitFor(() => expect(lastClusterRequest(fetchMock).get('provider')).toBe('aws'))
    expect(lastClusterRequest(fetchMock).get('source')).toBe('aws-platform')

    await user.click(screen.getByRole('button', { name: 'AKS, 3 clusters' }))
    await waitFor(() => expect(lastClusterRequest(fetchMock).get('provider')).toBe('azure'))
    expect(lastClusterRequest(fetchMock).has('source')).toBe(false)
  })
})

describe('inventoryStatus', () => {
  it.each([
    ['active', null, 'active'],
    ['running', null, 'active'],
    ['succeeded', null, 'active'],
    ['', null, 'active'],
    ['degraded', null, 'degraded'],
    ['provisioning', null, 'provisioning'],
    ['active', '2026-01-01T00:00:00Z', 'removed'],
  ])('reads %s (removed %s) as %s', (status, removedAt, expected) => {
    expect(inventoryStatus(buildCluster(status, { removedAt }))).toBe(expected)
  })
})
