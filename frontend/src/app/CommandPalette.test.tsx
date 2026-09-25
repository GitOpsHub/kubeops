import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { buildApplication, buildCluster, mockAPI } from '../test/mock-api'
import { renderApp } from '../test/render'

afterEach(() => {
  vi.restoreAllMocks()
})

function palette() {
  return screen.findByRole('dialog', { name: 'Command palette' })
}

function paletteInput() {
  return screen.getByRole('combobox', { name: 'Search pages, applications, and clusters' })
}

describe('command palette', () => {
  it('opens on ⌘K and navigates to the best match on Enter', async () => {
    mockAPI()
    const user = userEvent.setup()
    renderApp()
    await screen.findByRole('heading', { name: 'Overview', level: 1 })

    await user.keyboard('{Meta>}k{/Meta}')
    await palette()
    expect(paletteInput()).toHaveFocus()

    await user.type(paletteInput(), 'clus')
    await user.keyboard('{Enter}')

    expect(await screen.findByRole('heading', { name: 'Clusters', level: 1 })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument()
  })

  it('opens with Ctrl+K too, and Escape closes it and restores focus', async () => {
    mockAPI()
    const user = userEvent.setup()
    renderApp()

    const clustersLink = within(screen.getByRole('navigation', { name: 'Primary' })).getByRole(
      'link',
      { name: 'Clusters' },
    )
    clustersLink.focus()
    await user.keyboard('{Control>}k{/Control}')
    await palette()

    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument(),
    )
    expect(clustersLink).toHaveFocus()
  })

  it('opens from the header search button and returns focus to it', async () => {
    mockAPI()
    const user = userEvent.setup()
    renderApp()

    const trigger = screen.getByRole('button', { name: 'Search…' })
    await user.click(trigger)
    await palette()
    await user.keyboard('{Escape}')

    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('moves the active option with the arrow keys', async () => {
    mockAPI()
    const user = userEvent.setup()
    renderApp()

    await user.keyboard('{Meta>}k{/Meta}')
    const dialog = await palette()
    const options = within(dialog).getAllByRole('option')
    const input = paletteInput()
    expect(input).toHaveAttribute('aria-activedescendant', options[0].id)
    expect(options[0]).toHaveAttribute('aria-selected', 'true')

    await user.keyboard('{ArrowDown}')
    expect(input).toHaveAttribute('aria-activedescendant', options[1].id)
    // Up from the first wraps to the last.
    await user.keyboard('{ArrowUp}{ArrowUp}')
    expect(input).toHaveAttribute('aria-activedescendant', options[options.length - 1].id)
  })

  it('finds an application by name and opens it', async () => {
    mockAPI({ applications: [buildApplication()] })
    const user = userEvent.setup()
    renderApp()

    await user.keyboard('{Meta>}k{/Meta}')
    const dialog = await palette()
    await user.type(paletteInput(), 'payments')

    const applications = await within(dialog).findByRole('group', { name: 'Applications' })
    await user.click(within(applications).getByRole('option', { name: /payments-api/ }))

    expect(
      await screen.findByRole('heading', { name: 'payments-api', level: 1 }),
    ).toBeInTheDocument()
  })

  it('searches clusters on the server and opens the cluster list', async () => {
    const { fetchMock } = mockAPI({
      clusters: [buildCluster('active'), buildCluster('active', { id: 'c2', name: 'staging-eu' })],
    })
    const user = userEvent.setup()
    renderApp()

    await user.keyboard('{Meta>}k{/Meta}')
    const dialog = await palette()
    await user.type(paletteInput(), 'staging')

    const clusters = await within(dialog).findByRole('group', { name: 'Clusters' })
    expect(within(clusters).getAllByRole('option')).toHaveLength(1)
    expect(
      fetchMock.mock.calls.some(([request]) => String(request).includes('search=staging')),
    ).toBe(true)

    await user.click(within(clusters).getByRole('option', { name: /staging-eu/ }))
    expect(await screen.findByRole('heading', { name: 'Clusters', level: 1 })).toBeInTheDocument()
  })

  it('says so when nothing matches', async () => {
    mockAPI()
    const user = userEvent.setup()
    renderApp()

    await user.keyboard('{Meta>}k{/Meta}')
    const dialog = await palette()
    await user.type(paletteInput(), 'zzzzqx')

    expect(await within(dialog).findByText('No results for “zzzzqx”')).toBeInTheDocument()
    expect(paletteInput()).toHaveAttribute('aria-expanded', 'false')
  })

  it('switches the theme', async () => {
    mockAPI()
    const user = userEvent.setup()
    renderApp()

    await user.keyboard('{Meta>}k{/Meta}')
    await palette()
    await user.type(paletteInput(), 'theme: dark')
    await user.keyboard('{Enter}')

    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
  })

  it('queues a sync for every enabled cloud source', async () => {
    const { state } = mockAPI()
    const user = userEvent.setup()
    renderApp()

    await user.keyboard('{Meta>}k{/Meta}')
    const dialog = await palette()
    await user.click(within(dialog).getByRole('option', { name: /Sync all cloud sources/ }))

    expect(await screen.findByText('Sync queued for 3 of 3 cloud sources.')).toBeInTheDocument()
    expect(state.syncedSources).toEqual(['aws-platform', 'gcp-platform', 'azure-platform'])
    // The shell's heartbeat picks up the queued run without waiting for its poll.
    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' })
    expect(await within(sidebar).findByText('Sync queued')).toBeInTheDocument()
  })

  it('has no accessibility violations while open', async () => {
    mockAPI()
    const user = userEvent.setup()
    renderApp()

    await user.keyboard('{Meta>}k{/Meta}')
    const dialog = await palette()
    expect(await axe(dialog)).toHaveNoViolations()
  })
})
