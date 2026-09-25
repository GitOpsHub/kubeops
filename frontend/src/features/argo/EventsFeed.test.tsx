import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resourceEventsHref } from '../application-detail/detail-links'
import { buildApplication, buildEvent, mockAPI } from '../../test/mock-api'
import { renderApp } from '../../test/render'

afterEach(() => {
  vi.restoreAllMocks()
})

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

const events = [
  buildEvent({
    type: 'Normal',
    reason: 'OperationStarted',
    message: 'Initiated automated sync to abc1234',
    lastSeen: minutesAgo(1),
    object: { kind: 'Application', name: 'payments-api', uid: 'uid-app' },
  }),
  buildEvent({
    type: 'Warning',
    reason: 'BackOff',
    message: 'Back-off restarting failed container app',
    count: 7,
    lastSeen: minutesAgo(2),
    object: { kind: 'Pod', name: 'payments-api-abc', namespace: 'payments', uid: 'uid-pod' },
  }),
  buildEvent({
    type: 'Normal',
    reason: 'Pulled',
    message: 'Container image already present on machine',
    lastSeen: minutesAgo(3),
    object: { kind: 'Pod', name: 'payments-api-abc', namespace: 'payments', uid: 'uid-pod' },
  }),
]

function groupNames() {
  return screen
    .queryAllByRole('region')
    .filter((region) => region.classList.contains('event-group'))
    .map((region) => region.getAttribute('aria-label'))
}

describe('EventsFeed', () => {
  it('groups events by object with warnings first, and filters them', async () => {
    mockAPI({ applications: [buildApplication()], targetEvents: { 'target-1': events } })
    renderApp('/applications/onboarding-1?tab=events')
    const user = userEvent.setup()

    const pod = await screen.findByRole('region', { name: 'Pod payments-api-abc' })
    expect(groupNames()).toEqual(['Pod payments-api-abc', 'Application payments-api'])
    expect(pod).toHaveTextContent('7 warnings')
    expect(within(pod).getByText('×7')).toBeInTheDocument()
    expect(within(pod).getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByText('3 events · 1 warning')).toBeInTheDocument()

    await user.click(screen.getByRole('switch', { name: 'Warnings only' }))
    expect(groupNames()).toEqual(['Pod payments-api-abc'])
    expect(
      within(screen.getByRole('region', { name: 'Pod payments-api-abc' })).getAllByRole('listitem'),
    ).toHaveLength(1)
    await user.click(screen.getByRole('switch', { name: 'Warnings only' }))

    await user.selectOptions(screen.getByRole('combobox', { name: 'Kind' }), 'Application')
    expect(groupNames()).toEqual(['Application payments-api'])
    await user.selectOptions(screen.getByRole('combobox', { name: 'Kind' }), '')

    await user.type(screen.getByRole('searchbox', { name: 'Search events' }), 'image already')
    expect(groupNames()).toEqual(['Pod payments-api-abc'])
    expect(screen.getByText('Pulled')).toBeInTheDocument()
    expect(screen.queryByText('BackOff')).not.toBeInTheDocument()

    await user.type(screen.getByRole('searchbox', { name: 'Search events' }), ' nowhere')
    expect(screen.getByText('No events match these filters')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(groupNames()).toHaveLength(2)
  })

  it('narrows to one resource from a link and widens back to the application', async () => {
    const { fetchMock } = mockAPI({
      applications: [buildApplication()],
      targetEvents: { 'target-1': events },
    })
    const href = resourceEventsHref('onboarding-1', 'target-1', {
      uid: 'uid-pod',
      kind: 'Pod',
      name: 'payments-api-abc',
      namespace: 'payments',
    })
    expect(href).toBe(
      '/applications/onboarding-1?tab=events&target=target-1&uid=uid-pod&kind=Pod&name=payments-api-abc&namespace=payments',
    )
    renderApp(href)
    const user = userEvent.setup()

    expect(await screen.findByRole('note')).toHaveTextContent(
      'Showing events for Pod payments-api-abc',
    )
    await screen.findByRole('region', { name: 'Pod payments-api-abc' })
    expect(groupNames()).toEqual(['Pod payments-api-abc'])
    const eventCalls = fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes('/events'))
    expect(eventCalls.at(-1)).toContain('uid=uid-pod')

    await user.click(screen.getByRole('button', { name: 'Show application events' }))
    await waitFor(() => expect(groupNames()).toHaveLength(2))
    expect(screen.queryByText(/Showing events for/)).not.toBeInTheDocument()
  })

  it('honours the uid-only link from a resource Info panel', async () => {
    const { fetchMock } = mockAPI({
      applications: [buildApplication()],
      targetEvents: { 'target-1': events },
    })
    renderApp('/applications/onboarding-1?target=target-1&tab=events&uid=uid-pod')

    expect(await screen.findByRole('tab', { name: 'Events' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await screen.findByRole('region', { name: 'Pod payments-api-abc' })
    expect(groupNames()).toEqual(['Pod payments-api-abc'])
    expect(screen.getByRole('note')).toHaveTextContent('Showing events for Pod payments-api-abc')
    const eventCalls = fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes('/events'))
    expect(eventCalls.at(-1)).toMatch(/\/targets\/target-1\/events\?uid=uid-pod$/)
  })

  it('explains an empty feed', async () => {
    mockAPI({ applications: [buildApplication()] })
    renderApp('/applications/onboarding-1?tab=events')

    expect(await screen.findByText('No recent events')).toBeInTheDocument()
  })
})
