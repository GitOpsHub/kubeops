import { act, fireEvent, renderHook, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { ToastProvider } from './Toast'
import { useToast, type ToastApi } from './toast-context'

let toast: ToastApi

function renderToasts() {
  const rendered = renderHook(() => useToast(), { wrapper: ToastProvider })
  toast = rendered.result.current
  return rendered
}

describe('toasts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('mounts an empty notifications region before any toast', () => {
    renderToasts()

    const region = screen.getByRole('region', { name: 'Notifications' })
    expect(within(region).getByRole('list')).toBeEmptyDOMElement()
  })

  it('announces outcomes as status and failures as alerts', async () => {
    renderToasts()

    act(() => {
      toast.success('Synchronization started.')
      toast.error('Sync could not be started.')
    })

    expect(screen.getByRole('status')).toHaveTextContent('Synchronization started.')
    expect(screen.getByRole('alert')).toHaveTextContent('Sync could not be started.')
    // Real timers for axe, which schedules its own work.
    vi.useRealTimers()
    expect(await axe(screen.getByRole('region', { name: 'Notifications' }))).toHaveNoViolations()
  })

  it('dismisses itself after five seconds, and errors after ten', () => {
    renderToasts()
    act(() => {
      toast.info('Queued.')
      toast.error('Failed.')
    })

    act(() => vi.advanceTimersByTime(5_000))
    expect(screen.queryByText('Queued.')).not.toBeInTheDocument()
    expect(screen.getByText('Failed.')).toBeInTheDocument()

    act(() => vi.advanceTimersByTime(5_000))
    expect(screen.queryByText('Failed.')).not.toBeInTheDocument()
  })

  it('holds while hovered and resumes with the time that was left', () => {
    renderToasts()
    act(() => {
      toast.success('Scaled.')
    })
    const region = screen.getByRole('region', { name: 'Notifications' })

    act(() => vi.advanceTimersByTime(3_000))
    fireEvent.pointerEnter(region)
    act(() => vi.advanceTimersByTime(10_000))
    expect(screen.getByText('Scaled.')).toBeInTheDocument()

    fireEvent.pointerLeave(region)
    act(() => vi.advanceTimersByTime(1_900))
    expect(screen.getByText('Scaled.')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(100))
    expect(screen.queryByText('Scaled.')).not.toBeInTheDocument()
  })

  it('can be dismissed, and keeps only the three newest', () => {
    renderToasts()
    act(() => {
      for (const message of ['one', 'two', 'three', 'four']) toast.info(message)
    })

    expect(screen.queryByText('one')).not.toBeInTheDocument()
    expect(screen.getAllByRole('status')).toHaveLength(3)

    const [first] = screen.getAllByRole('button', { name: 'Dismiss notification' })
    fireEvent.click(first)
    expect(screen.queryByText('two')).not.toBeInTheDocument()
  })

  it('follows a promise from loading to its outcome in one toast', async () => {
    renderToasts()
    let resolve!: (value: number) => void
    const pending = new Promise<number>((done) => {
      resolve = done
    })

    act(() => {
      void toast.promise(pending, {
        loading: 'Scaling…',
        success: (count) => `Scaled to ${count}.`,
        error: 'Scale failed.',
      })
    })
    expect(screen.getByRole('status')).toHaveTextContent('Scaling…')
    // A loading toast never times out on its own.
    act(() => vi.advanceTimersByTime(60_000))
    expect(screen.getByText('Scaling…')).toBeInTheDocument()

    await act(async () => resolve(4))
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(screen.getByRole('status')).toHaveTextContent('Scaled to 4.')
  })
})
