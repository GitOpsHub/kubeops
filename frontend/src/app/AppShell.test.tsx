import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { renderApp } from '../test/render'
import { buildApplication, buildSyncRun, mockAPI } from '../test/mock-api'

const store = new Map<string, string>()

beforeEach(() => {
  store.clear()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** A `matchMedia` where only the given max-width queries match, as on a narrow screen. */
function stubViewport(width: number) {
  vi.stubGlobal('matchMedia', (query: string) => {
    const maxWidth = /max-width:\s*(\d+)px/.exec(query)
    return {
      matches: maxWidth ? width <= Number(maxWidth[1]) : false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }
  })
}

describe('app shell', () => {
  it('marks the current section in the sidebar and the breadcrumb', async () => {
    mockAPI({ applications: [buildApplication()] })
    const user = userEvent.setup()
    renderApp('/clusters')

    const nav = screen.getByRole('navigation', { name: 'Primary' })
    expect(within(nav).getByRole('link', { name: 'Clusters' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(within(breadcrumb).getByText('Clusters')).toHaveAttribute('aria-current', 'page')

    await user.click(within(nav).getByRole('link', { name: 'Applications' }))
    await user.click(await screen.findByRole('link', { name: 'payments-api' }))

    // The detail breadcrumb links back to the section and names the application.
    await screen.findByRole('heading', { name: 'payments-api', level: 1 })
    expect(within(breadcrumb).getByRole('link', { name: 'Applications' })).toHaveAttribute(
      'href',
      '/applications',
    )
    expect(within(breadcrumb).getByText('payments-api')).toHaveAttribute('aria-current', 'page')
  })

  it('collapses the sidebar, keeps link names, and remembers the choice', async () => {
    mockAPI()
    const user = userEvent.setup()
    const view = renderApp()

    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    expect(document.querySelector('.app-shell')).toHaveClass('is-collapsed')
    expect(store.get('kubeops.sidebar')).toBe('collapsed')
    // Labels are only visually hidden, so every link keeps its name.
    const nav = screen.getByRole('navigation', { name: 'Primary' })
    expect(within(nav).getByRole('link', { name: 'Cloud sources' })).toBeInTheDocument()

    view.unmount()
    renderApp()
    expect(document.querySelector('.app-shell')).toHaveClass('is-collapsed')
    await user.click(screen.getByRole('button', { name: 'Expand sidebar' }))
    expect(document.querySelector('.app-shell')).not.toHaveClass('is-collapsed')
  })

  it('opens the navigation drawer and closes it after navigating', async () => {
    mockAPI()
    const user = userEvent.setup()
    renderApp()

    await user.click(screen.getByRole('button', { name: 'Open navigation' }))
    const drawer = await screen.findByRole('dialog', { name: 'Navigation' })
    await user.click(within(drawer).getByRole('link', { name: 'Cloud sources' }))

    expect(
      await screen.findByRole('heading', { name: 'Cloud sources', level: 1 }),
    ).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Navigation' })).not.toBeInTheDocument()
    })
  })

  it('reports a failed latest sync in the sidebar readout', async () => {
    mockAPI({ syncRuns: [buildSyncRun({ status: 'failed', error: 'AccessDenied' })] })
    renderApp('/applications')

    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' })
    expect(await within(sidebar).findByText('Sync failed')).toBeInTheDocument()
  })

  it('contains a page crash to the content area', async () => {
    mockAPI()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // An API shape the page does not expect makes the overview throw while rendering.
    const fetchMock = vi.mocked(globalThis.fetch)
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (request, init) => {
      if (String(request).includes('/overview')) return Response.json({ clusters: null })
      return original(request, init)
    })
    renderApp()

    expect(await screen.findByText('This page failed to render')).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeInTheDocument()
  })

  it('auto-collapses to the icon rail on a tablet without touching the stored choice', async () => {
    stubViewport(800)
    mockAPI()
    const user = userEvent.setup()
    renderApp()

    expect(document.querySelector('.app-shell')).toHaveClass('is-collapsed')
    expect(store.has('kubeops.sidebar')).toBe(false)
    const nav = screen.getByRole('navigation', { name: 'Primary' })
    expect(within(nav).getByRole('link', { name: 'Clusters' })).toBeInTheDocument()

    // Opening the rail there is a moment's choice, not a preference.
    await user.click(screen.getByRole('button', { name: 'Expand sidebar' }))
    expect(document.querySelector('.app-shell')).not.toHaveClass('is-collapsed')
    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    expect(document.querySelector('.app-shell')).toHaveClass('is-collapsed')
    expect(store.has('kubeops.sidebar')).toBe(false)
  })

  it('keeps the stored expanded layout on a desktop', () => {
    stubViewport(1440)
    mockAPI()
    renderApp()
    expect(document.querySelector('.app-shell')).not.toHaveClass('is-collapsed')
  })

  it('groups the navigation and marks only the onboarding item on its page', async () => {
    mockAPI()
    renderApp('/applications/new')

    const nav = screen.getByRole('navigation', { name: 'Primary' })
    const operate = within(nav).getByRole('list', { name: 'Operate' })
    expect(within(operate).getByRole('link', { name: 'Onboard application' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(operate).getByRole('link', { name: 'Applications' })).not.toHaveAttribute(
      'aria-current',
    )
    const inventory = within(nav).getByRole('list', { name: 'Inventory' })
    expect(
      within(inventory)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Clusters', 'Cloud sources'])
  })

  it('shows recent sync runs in the header menu and links to their source', async () => {
    mockAPI({
      syncRuns: [
        buildSyncRun({ id: 'run-2', status: 'running' }),
        buildSyncRun({ id: 'run-1', status: 'failed', sourceName: 'Google Cloud Platform' }),
      ],
    })
    const user = userEvent.setup()
    renderApp()

    const trigger = await screen.findByRole('button', { name: 'Sync status: Sync running' })
    await user.click(trigger)
    const menu = await screen.findByRole('menu')
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(3)
    expect(within(menu).getByRole('menuitem', { name: /Google Cloud Platform/ })).toHaveTextContent(
      'Failed',
    )

    await user.click(within(menu).getByRole('menuitem', { name: 'View cloud sources' }))
    expect(
      await screen.findByRole('heading', { name: 'Cloud sources', level: 1 }),
    ).toBeInTheDocument()
  })

  it('has no accessibility violations in the shell', async () => {
    mockAPI()
    const { container } = renderApp('/clusters')
    await screen.findByRole('heading', { name: 'Clusters', level: 1 })
    expect(await axe(container, { rules: { region: { enabled: false } } })).toHaveNoViolations()
  })
})
