import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildSyncRun, mockAPI } from '../../test/mock-api'
import { renderApp } from '../../test/render'
import { RunHistory } from './RunHistory'
import { formatDuration, runDurationMs, runsBySource } from './run-format'

const start = '2026-09-01T10:00:00.000Z'

function at(offsetMs: number) {
  return new Date(new Date(start).getTime() + offsetMs).toISOString()
}

function runRequests(fetchMock: ReturnType<typeof mockAPI>['fetchMock']) {
  return fetchMock.mock.calls
    .map(([request]) => new URL(String(request), 'http://localhost'))
    .filter((url) => url.pathname.endsWith('/sync-runs'))
    .map((url) => url.searchParams)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('run durations', () => {
  it.each([
    [null, '—'],
    [0, '0ms'],
    [840, '840ms'],
    [4_240, '4.2s'],
    [42_400, '42s'],
    [192_000, '3m 12s'],
    [3_840_000, '1h 04m'],
  ])('formats %s ms as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected)
  })

  it.each([
    ['a queued run', { startedAt: null, completedAt: null }, null],
    ['a finished run', { startedAt: start, completedAt: at(4_200) }, 4_200],
    ['a running run, against now', { startedAt: start, completedAt: null }, 9_000],
    ['garbled timestamps', { startedAt: 'nope', completedAt: at(1) }, null],
  ])('measures %s', (_, times, expected) => {
    expect(runDurationMs(buildSyncRun(times), new Date(at(9_000)).getTime())).toBe(expected)
  })

  it('caps the runs kept per source', () => {
    const runs = [
      buildSyncRun({ id: '1', sourceId: 'a' }),
      buildSyncRun({ id: '2', sourceId: 'b' }),
      buildSyncRun({ id: '3', sourceId: 'a' }),
      buildSyncRun({ id: '4', sourceId: 'a' }),
    ]
    const grouped = runsBySource(runs, 2)
    expect(grouped.get('a')?.map((run) => run.id)).toEqual(['1', '3'])
    expect(grouped.get('b')?.map((run) => run.id)).toEqual(['2'])
  })
})

describe('RunHistory', () => {
  it('draws newest on the right, pads empty slots, and names the tally', () => {
    const { container } = render(
      <RunHistory
        label="Recent runs for AWS"
        slots={5}
        runs={[
          buildSyncRun({ id: 'new', status: 'running' }),
          buildSyncRun({ id: 'mid', status: 'failed' }),
          buildSyncRun({ id: 'old', status: 'succeeded' }),
        ]}
      />,
    )
    expect(
      screen.getByRole('img', {
        name: 'Recent runs for AWS: last 3 runs, 1 succeeded, 1 failed, 1 running',
      }),
    ).toBeInTheDocument()
    const ticks = [...container.querySelectorAll('.run-tick')]
    expect(ticks).toHaveLength(5)
    expect(ticks.map((tick) => tick.getAttribute('data-tone'))).toEqual([
      null,
      null,
      'ok',
      'err',
      'info',
    ])
    expect(ticks[4]).toHaveClass('run-tick--pulse')
  })

  it('says so when a source has never run', () => {
    render(<RunHistory label="Recent runs for GCP" runs={[]} />)
    expect(
      screen.getByRole('img', { name: 'Recent runs for GCP: no runs yet' }),
    ).toBeInTheDocument()
  })
})

describe('sync runs table', () => {
  it('shows each run’s counts and how long it took', async () => {
    mockAPI({
      syncRuns: [
        buildSyncRun({
          id: 'run-a',
          discoveredCount: 7,
          changedCount: 2,
          removedCount: 1,
          startedAt: start,
          completedAt: at(4_200),
        }),
      ],
    })
    renderApp('/sources')

    const table = await screen.findByRole('table', { name: 'Sync runs' })
    const row = within(table).getAllByRole('row')[1]
    const cells = within(row).getAllByRole('cell')
    expect(cells.map((cell) => cell.textContent)).toEqual(
      expect.arrayContaining(['AWS Platform', 'scheduled', 'succeeded', '7', '2', '1', '4.2s']),
    )
  })

  it('filters runs by the source in the URL and highlights that source', async () => {
    const { fetchMock } = mockAPI({
      syncRuns: [
        buildSyncRun({ id: 'aws-run' }),
        buildSyncRun({
          id: 'gcp-run',
          sourceId: 'gcp-platform',
          sourceName: 'Google Cloud Platform',
          provider: 'gcp',
        }),
      ],
    })
    renderApp('/sources?source=gcp-platform')

    const table = await screen.findByRole('table', { name: 'Sync runs' })
    expect(within(table).getAllByRole('row')).toHaveLength(2)
    expect(within(table).getByText('Google Cloud Platform')).toBeInTheDocument()
    expect(
      runRequests(fetchMock).some(
        (params) => params.get('sourceId') === 'gcp-platform' && params.get('limit') === '50',
      ),
    ).toBe(true)
    expect(
      await screen.findByRole('button', { name: /^Source Google Cloud Platform/ }),
    ).toBeInTheDocument()
    expect(screen.getByRole('listitem', { name: 'Google Cloud Platform' })).toHaveClass(
      'is-selected',
    )
  })

  it('switches the source filter from a card and from the menu', async () => {
    const { fetchMock } = mockAPI()
    const user = userEvent.setup()
    renderApp('/sources')

    const azure = await screen.findByRole('listitem', { name: 'Azure Platform' })
    await user.click(within(azure).getByRole('button', { name: 'View runs' }))
    await waitFor(() =>
      expect(runRequests(fetchMock).at(-1)?.get('sourceId')).toBe('azure-platform'),
    )
    expect(within(azure).getByRole('button', { name: 'View runs' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(await screen.findByText('No runs for this source yet')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^Source Azure Platform/ }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'All sources' }))
    await waitFor(() => expect(runRequests(fetchMock).at(-1)?.has('sourceId')).toBe(false))
    expect(await screen.findByRole('table', { name: 'Sync runs' })).toBeInTheDocument()
  })

  it('loads more runs in pages of 50 until the API has no more', async () => {
    const { fetchMock } = mockAPI({
      syncRuns: Array.from({ length: 120 }, (_, index) => buildSyncRun({ id: `run-${index}` })),
    })
    const user = userEvent.setup()
    renderApp('/sources')

    expect(await screen.findByText('Showing 50 runs')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Load more' }))
    expect(await screen.findByText('Showing 100 runs')).toBeInTheDocument()
    expect(runRequests(fetchMock).some((params) => params.get('limit') === '100')).toBe(true)

    await user.click(screen.getByRole('button', { name: 'Load more' }))
    expect(await screen.findByText('Showing 120 runs')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
  })
})
