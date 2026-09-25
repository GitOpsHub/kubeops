import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { ResourceNode } from '../../api/onboarding'
import { ToastProvider } from '../../components/ui/Toast'
import { buildResource, buildTarget, mockAPI } from '../../test/mock-api'
import { ResourceExplorer } from './ResourceExplorer'
import { ResourceGraph } from './ResourceGraph'
import { healthFlashMs } from './useHealthFlash'

const fixture: ResourceNode[] = [
  buildResource({ uid: 'dep', kind: 'Deployment', name: 'api' }),
  buildResource({
    uid: 'rs',
    kind: 'ReplicaSet',
    name: 'api-7d9f8',
    parentUid: 'dep',
    syncStatus: '',
  }),
  buildResource({
    uid: 'pod-a',
    kind: 'Pod',
    name: 'api-7d9f8-aaaaa',
    parentUid: 'rs',
    syncStatus: '',
  }),
  buildResource({
    uid: 'pod-b',
    kind: 'Pod',
    name: 'api-7d9f8-bbbbb',
    parentUid: 'rs',
    syncStatus: '',
    healthStatus: 'Degraded',
    info: [{ name: 'Status Reason', value: 'CrashLoopBackOff' }],
  }),
  buildResource({
    uid: 'svc',
    group: '',
    kind: 'Service',
    name: 'api-svc',
    healthStatus: 'Progressing',
    syncStatus: 'OutOfSync',
  }),
  buildResource({ uid: 'cm', group: '', kind: 'ConfigMap', name: 'api-config' }),
]

function renderGraph(props: Partial<Parameters<typeof ResourceGraph>[0]> = {}) {
  const handlers = { onSelect: vi.fn(), onDelete: vi.fn(), onLogs: vi.fn() }
  const view = render(
    <ResourceGraph nodes={fixture} label="Resources on prod" {...handlers} {...props} />,
  )
  return { ...view, handlers }
}

const cardNames = () =>
  within(screen.getByRole('list', { name: 'Resources on prod' }))
    .getAllByRole('listitem')
    .map((item) => item.querySelector('.graph-card-name')?.textContent)

describe('resource graph', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('lists cards owner first with canonical status labels and the reason for trouble', () => {
    renderGraph()
    expect(cardNames()).toEqual([
      'api-config',
      'api',
      'api-7d9f8',
      'api-7d9f8-aaaaa',
      'api-7d9f8-bbbbb',
      'api-svc',
    ])
    const service = screen.getByRole('button', { name: 'Actions for Service api-svc' })
    expect(within(service).getByRole('img', { name: 'Sync: Out of Sync' })).toBeInTheDocument()
    expect(within(service).getByRole('img', { name: 'Health: Progressing' })).toBeInTheDocument()
    expect(within(service).getByText('Progressing')).toBeInTheDocument()
    expect(
      within(screen.getByRole('button', { name: 'Actions for Pod api-7d9f8-bbbbb' })).getByText(
        'Degraded · CrashLoopBackOff',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText('4 of 6 healthy')).toBeInTheDocument()
  })

  it('has no accessibility violations', async () => {
    const { container } = renderGraph({ selectedUid: 'dep', operationRunning: true })
    expect(await axe(container)).toHaveNoViolations()
  })

  it('hides ReplicaSets and Pods, reports what is shown, and clears', async () => {
    const user = userEvent.setup()
    renderGraph()

    await user.click(screen.getByRole('switch', { name: 'Hide ReplicaSets & Pods' }))
    expect(cardNames()).toEqual(['api-config', 'api', 'api-svc'])
    expect(screen.getByText('Showing 3 of 6 resources')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(cardNames()).toHaveLength(6)
    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Hide ReplicaSets & Pods' })).not.toBeChecked()
  })

  it('filters by several kinds at once', async () => {
    const user = userEvent.setup()
    renderGraph()

    await user.click(screen.getByRole('button', { name: /^Kind/ }))
    const menu = screen.getByRole('menu')
    expect(
      within(menu)
        .getAllByRole('menuitemcheckbox')
        .map((item) => item.textContent),
    ).toEqual(['ConfigMap1', 'Deployment1', 'Pod2', 'ReplicaSet1', 'Service1'])
    // The menu stays open, so a second kind is one more click.
    await user.click(within(menu).getByRole('menuitemcheckbox', { name: /^Pod/ }))
    await user.click(within(menu).getByRole('menuitemcheckbox', { name: /^Service/ }))
    await user.keyboard('{Escape}')

    expect(cardNames()).toEqual(['api-7d9f8-aaaaa', 'api-7d9f8-bbbbb', 'api-svc'])
    expect(screen.getByRole('button', { name: /^Kind/ })).toHaveTextContent('Pod, Service')
    expect(screen.getByText('Showing 3 of 6 resources')).toBeInTheDocument()
  })

  it('filters by health and sync with counts per state', async () => {
    const user = userEvent.setup()
    renderGraph()

    await user.click(screen.getByRole('button', { name: /^Health/ }))
    expect(screen.getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual([
      'Any health',
      'Healthy4',
      'Progressing1',
      'Degraded1',
    ])
    await user.click(screen.getByRole('menuitemradio', { name: /^Degraded/ }))
    expect(cardNames()).toEqual(['api-7d9f8-bbbbb'])

    await user.click(screen.getByRole('button', { name: /^Health/ }))
    await user.click(screen.getByRole('menuitemradio', { name: 'Any health' }))
    await user.click(screen.getByRole('button', { name: /^Sync/ }))
    expect(screen.getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual([
      'Any sync',
      'Synced2',
      'Out of Sync1',
    ])
    await user.click(screen.getByRole('menuitemradio', { name: /^Out of Sync/ }))
    expect(cardNames()).toEqual(['api-svc'])
  })

  it('explains an empty result and offers to clear it', async () => {
    const user = userEvent.setup()
    renderGraph()

    await user.click(screen.getByRole('button', { name: /^Sync/ }))
    await user.click(screen.getByRole('menuitemradio', { name: /^Out of Sync/ }))
    await user.click(screen.getByRole('switch', { name: 'Hide ReplicaSets & Pods' }))
    await user.click(screen.getByRole('button', { name: /^Health/ }))
    await user.click(screen.getByRole('menuitemradio', { name: /^Healthy/ }))

    expect(screen.getByText('No resources match these filters')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Resources on prod' })).not.toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: 'Clear filters' })[1])
    expect(cardNames()).toHaveLength(6)
  })

  it('dims search misses instead of removing them', async () => {
    const user = userEvent.setup()
    renderGraph()

    await user.type(screen.getByRole('searchbox', { name: 'Search resources' }), 'bbbbb')
    expect(cardNames()).toHaveLength(6)
    const dimmed = [...document.querySelectorAll('.graph-card.is-dimmed .graph-card-name')].map(
      (name) => name.textContent,
    )
    expect(dimmed).not.toContain('api-7d9f8-bbbbb')
    expect(dimmed).toHaveLength(5)
    expect(screen.getByText(/Showing 6 of 6 resources · 1 match/)).toBeInTheDocument()
  })

  it('keeps the exact card menus', async () => {
    const user = userEvent.setup()
    const { handlers } = renderGraph()

    await user.click(screen.getByRole('button', { name: 'Actions for Pod api-7d9f8-aaaaa' }))
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Info',
      'Logs',
      'Delete',
    ])
    await user.click(screen.getByRole('menuitem', { name: 'Logs' }))
    expect(handlers.onLogs).toHaveBeenCalledWith(expect.objectContaining({ uid: 'pod-a' }))

    await user.click(screen.getByRole('button', { name: 'Actions for Deployment api' }))
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Info',
      'Delete',
    ])
  })

  it('flashes a card whose health changed, never on first render', () => {
    vi.useFakeTimers()
    const { rerender, handlers } = renderGraph()
    const card = () =>
      screen.getByRole('button', { name: 'Actions for Deployment api' }).closest('article')!

    expect(document.querySelector('[data-changed]')).toBeNull()

    // A poll with identical health changes nothing.
    rerender(<ResourceGraph nodes={[...fixture]} label="Resources on prod" {...handlers} />)
    expect(document.querySelector('[data-changed]')).toBeNull()

    const degraded = fixture.map((node) =>
      node.uid === 'dep' ? { ...node, healthStatus: 'Degraded' } : node,
    )
    rerender(<ResourceGraph nodes={degraded} label="Resources on prod" {...handlers} />)
    expect(card()).toHaveAttribute('data-changed')
    expect(card()).toHaveAttribute('data-tone', 'err')
    expect(document.querySelectorAll('[data-changed]')).toHaveLength(1)

    act(() => vi.advanceTimersByTime(healthFlashMs))
    expect(card()).not.toHaveAttribute('data-changed')
  })

  it('animates edges only while a sync operation runs', () => {
    const { rerender, container, handlers } = renderGraph()
    expect(container.querySelector('.graph-edges')).not.toHaveClass('is-flowing')

    rerender(
      <ResourceGraph nodes={fixture} label="Resources on prod" operationRunning {...handlers} />,
    )
    expect(container.querySelector('.graph-edges')).toHaveClass('is-flowing')
  })

  it('zooms from the keyboard when the canvas is focused', () => {
    renderGraph()
    const canvas = screen.getByRole('group', { name: 'Resource graph canvas' })
    const level = () => document.querySelector('.graph-zoom-value')?.textContent
    // jsdom lays nothing out, so the initial fit bottoms out at the minimum.
    expect(level()).toBe('40%')
    expect(canvas).toHaveAttribute('tabindex', '0')
    expect(canvas).toHaveAccessibleDescription(/press plus or minus to zoom/i)

    canvas.focus()
    fireEvent.keyDown(canvas, { key: '+' })
    fireEvent.keyDown(canvas, { key: '=' })
    expect(level()).toBe('60%')
    fireEvent.keyDown(canvas, { key: '-' })
    expect(level()).toBe('50%')
    // Ctrl/⌘ plus belongs to the browser's page zoom.
    fireEvent.keyDown(canvas, { key: '+', ctrlKey: true })
    expect(level()).toBe('50%')
    fireEvent.keyDown(canvas, { key: '0' })
    expect(level()).toBe('40%')
  })

  it('pans by dragging the background but not from a card', () => {
    renderGraph()
    const canvas = screen.getByRole('group', { name: 'Resource graph canvas' })

    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 200, clientY: 200 })
    expect(canvas).toHaveClass('is-panning')
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 150, clientY: 170 })
    expect(canvas.scrollLeft).toBe(50)
    expect(canvas.scrollTop).toBe(30)
    fireEvent.pointerUp(canvas, { pointerId: 1 })
    expect(canvas).not.toHaveClass('is-panning')

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Actions for Deployment api' }), {
      button: 0,
      pointerId: 2,
    })
    expect(canvas).not.toHaveClass('is-panning')
  })
})

describe('resource explorer', () => {
  afterEach(() => vi.restoreAllMocks())

  it('passes a running sync through to the graph', async () => {
    mockAPI({ resources: [buildResource({ uid: 'dep' })] })
    const { container } = render(
      <MemoryRouter>
        <ToastProvider>
          <ResourceExplorer onboardingId="onboarding-1" target={buildTarget()} operationRunning />
        </ToastProvider>
      </MemoryRouter>,
    )
    await screen.findByRole('button', { name: 'Actions for Deployment payments-api' })
    expect(container.querySelector('.graph-edges')).toHaveClass('is-flowing')
  })
})
