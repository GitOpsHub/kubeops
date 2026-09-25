import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderApp } from '../../test/render'
import { buildApplication, buildTarget, mockAPI } from '../../test/mock-api'

function onboardingRequests(fetchMock: ReturnType<typeof mockAPI>['fetchMock']) {
  return fetchMock.mock.calls
    .map(([request]) => String(request))
    .filter((url) => url.includes('/application-onboardings?'))
}

const storedPreferences = new Map<string, string>()

beforeEach(() => {
  storedPreferences.clear()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storedPreferences.get(key) ?? null,
    setItem: (key: string, value: string) => storedPreferences.set(key, value),
    removeItem: (key: string) => storedPreferences.delete(key),
    clear: () => storedPreferences.clear(),
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const fleet = [
  buildApplication({ id: 'a', name: 'alpha', status: 'healthy' }),
  buildApplication({ id: 'b', name: 'bravo', status: 'failed' }),
  buildApplication({ id: 'c', name: 'charlie', status: 'healthy' }),
]

describe('applications status strip', () => {
  it('counts each status and filters through the same value as the Status select', async () => {
    mockAPI({ applications: fleet })
    const user = userEvent.setup()
    renderApp('/applications')

    const strip = await screen.findByRole('group', { name: 'Filter by status' })
    await within(strip).findByRole('button', { name: 'All 3' })
    expect(within(strip).getByRole('button', { name: 'All 3' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(within(strip).getByRole('button', { name: 'Healthy 2' })).toBeInTheDocument()
    // A status with nothing in it keeps its place rather than vanishing.
    expect(within(strip).getByRole('button', { name: 'Partial 0' })).toBeInTheDocument()
    expect(within(strip).queryByRole('button', { name: /Offboarded/ })).not.toBeInTheDocument()

    await user.click(within(strip).getByRole('button', { name: 'Failed 1' }))
    expect(within(strip).getByRole('button', { name: 'Failed 1' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('failed')
    expect(await screen.findByRole('link', { name: 'bravo' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'alpha' })).not.toBeInTheDocument()

    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'healthy')
    expect(within(strip).getByRole('button', { name: 'Healthy 2' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    await user.click(within(strip).getByRole('button', { name: 'Healthy 2' }))
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('')
    expect(await screen.findByRole('link', { name: 'bravo' })).toBeInTheDocument()
  })
})

describe('application tiles', () => {
  it('names each platform by its source, falling back to the raw ID', async () => {
    mockAPI({
      applications: [
        buildApplication({
          targets: [
            buildTarget({ id: 'target-1', sourceId: 'aws-platform' }),
            buildTarget({ id: 'target-2', sourceId: 'retired-source', clusterName: 'old' }),
          ],
        }),
      ],
    })
    renderApp('/applications')

    const card = (await screen.findByRole('link', { name: 'payments-api' })).closest('article')!
    expect(await within(card).findByText('AWS Platform')).toBeInTheDocument()
    expect(within(card).getByText('retired-source')).toBeInTheDocument()
    expect(within(card).queryByText('aws-platform')).not.toBeInTheDocument()
    expect(within(card).getByRole('link', { name: 'Argo CD' })).toHaveAttribute(
      'href',
      'https://argo.example.test/applications/payments-api',
    )
  })

  it('names platforms in the table too, keeping the raw ID in the title', async () => {
    storedPreferences.set('kubeops.applications.view', 'table')
    mockAPI({ applications: [buildApplication()] })
    renderApp('/applications')

    const row = (await screen.findByRole('link', { name: 'payments-api' })).closest('tr')!
    expect(await within(row).findByText('AWS Platform')).toHaveAttribute(
      'title',
      expect.stringContaining('aws-platform'),
    )
    expect(within(row).queryByText('aws-platform')).not.toBeInTheDocument()
  })
})

describe('applications polling', () => {
  it('refreshes the list every 20 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { fetchMock } = mockAPI({ applications: [buildApplication()] })
    renderApp('/applications')
    await screen.findByRole('link', { name: 'payments-api' })
    const initial = onboardingRequests(fetchMock).length

    act(() => vi.advanceTimersByTime(10_000))
    expect(onboardingRequests(fetchMock).length).toBe(initial)

    act(() => vi.advanceTimersByTime(10_000))
    await waitFor(() => expect(onboardingRequests(fetchMock).length).toBe(initial + 1))
  })
})
