import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
      if (String(request).includes('/cloud-sources')) return Response.json({ items: [null] })
      return original(request, init)
    })
    renderApp()

    expect(await screen.findByText('This page failed to render')).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeInTheDocument()
  })
})
