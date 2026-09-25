import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePolledResource } from './usePolledResource'

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state })
  document.dispatchEvent(new Event('visibilitychange'))
}

/** Settles pending promises; `waitFor` cannot poll while setInterval is faked. */
const flush = () => act(async () => {})

afterEach(() => {
  vi.useRealTimers()
  setVisibility('visible')
})

describe('usePolledResource', () => {
  it('reports loading until the first response, then holds the data', async () => {
    const load = vi.fn(async () => 'first')
    const { result } = renderHook(() => usePolledResource(load))

    expect(result.current.loading).toBe(true)
    expect(result.current.data).toBeUndefined()
    await waitFor(() => expect(result.current.data).toBe('first'))
    expect(result.current.loading).toBe(false)
    expect(result.current.refreshing).toBe(false)
    expect(result.current.lastUpdated).not.toBeNull()
  })

  it('polls on the interval and marks later requests as refreshing', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let resolveNext: (value: number) => void = () => {}
    let calls = 0
    const load = vi.fn(() => {
      calls += 1
      if (calls === 1) return Promise.resolve(1)
      return new Promise<number>((resolve) => {
        resolveNext = resolve
      })
    })
    const { result } = renderHook(() => usePolledResource(load, { intervalMs: 1_000 }))
    await flush()
    expect(result.current.data).toBe(1)

    act(() => vi.advanceTimersByTime(999))
    expect(load).toHaveBeenCalledTimes(1)
    act(() => vi.advanceTimersByTime(1))
    expect(load).toHaveBeenCalledTimes(2)
    expect(result.current.refreshing).toBe(true)
    expect(result.current.loading).toBe(false)

    // A tick while a request is still in flight does not stack another one.
    act(() => vi.advanceTimersByTime(1_000))
    expect(load).toHaveBeenCalledTimes(2)

    await act(async () => resolveNext(2))
    expect(result.current.data).toBe(2)
    expect(result.current.refreshing).toBe(false)
  })

  it('keeps stale data and backs off after failures', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let fail = false
    const load = vi.fn(async () => {
      if (fail) throw new Error('unreachable')
      return 'ok'
    })
    const { result } = renderHook(() => usePolledResource(load, { intervalMs: 1_000 }))
    await flush()
    expect(result.current.data).toBe('ok')

    fail = true
    // First failure: the normal cadence.
    await act(async () => vi.advanceTimersByTime(1_000))
    expect(result.current.error?.message).toBe('unreachable')
    expect(result.current.data).toBe('ok')
    expect(load).toHaveBeenCalledTimes(2)

    // Second failure waits one extra tick.
    await act(async () => vi.advanceTimersByTime(1_000))
    expect(load).toHaveBeenCalledTimes(3)
    await act(async () => vi.advanceTimersByTime(1_000))
    expect(load).toHaveBeenCalledTimes(3)
    await act(async () => vi.advanceTimersByTime(1_000))
    expect(load).toHaveBeenCalledTimes(4)

    // Recovery clears the error and the backoff.
    fail = false
    await act(async () => vi.advanceTimersByTime(1_000))
    await act(async () => vi.advanceTimersByTime(1_000))
    await act(async () => vi.advanceTimersByTime(1_000))
    await act(async () => vi.advanceTimersByTime(1_000))
    expect(result.current.error).toBeNull()
    expect(result.current.data).toBe('ok')
  })

  it('reschedules on a new interval without refetching or resetting the backoff', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let fail = false
    const load = vi.fn(async () => {
      if (fail) throw new Error('unreachable')
      return 'ok'
    })
    const { result, rerender } = renderHook(
      ({ intervalMs }) => usePolledResource(load, { intervalMs }),
      { initialProps: { intervalMs: 10_000 } },
    )
    await flush()
    expect(load).toHaveBeenCalledTimes(1)

    // Switching cadence keeps the data and issues no request of its own.
    rerender({ intervalMs: 1_000 })
    expect(load).toHaveBeenCalledTimes(1)
    expect(result.current.data).toBe('ok')
    await act(async () => vi.advanceTimersByTime(1_000))
    expect(load).toHaveBeenCalledTimes(2)

    // Two failures leave one tick to skip; a cadence change must not forget it.
    fail = true
    await act(async () => vi.advanceTimersByTime(1_000))
    await act(async () => vi.advanceTimersByTime(1_000))
    expect(load).toHaveBeenCalledTimes(4)
    rerender({ intervalMs: 2_000 })
    expect(load).toHaveBeenCalledTimes(4)
    await act(async () => vi.advanceTimersByTime(2_000))
    expect(load).toHaveBeenCalledTimes(4)
    await act(async () => vi.advanceTimersByTime(2_000))
    expect(load).toHaveBeenCalledTimes(5)
    expect(result.current.data).toBe('ok')
  })

  it('pauses while the tab is hidden and catches up when it returns', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const load = vi.fn(async () => 'data')
    renderHook(() => usePolledResource(load, { intervalMs: 1_000 }))
    await flush()
    expect(load).toHaveBeenCalledTimes(1)

    act(() => setVisibility('hidden'))
    act(() => vi.advanceTimersByTime(5_000))
    expect(load).toHaveBeenCalledTimes(1)

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5_000)
    act(() => setVisibility('visible'))
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('aborts the in-flight request on unmount and when the query changes', async () => {
    const signals: AbortSignal[] = []
    const makeLoad = () => (signal: AbortSignal) => {
      signals.push(signal)
      return new Promise<string>(() => {})
    }
    const { rerender, unmount } = renderHook(({ load }) => usePolledResource(load), {
      initialProps: { load: makeLoad() },
    })
    rerender({ load: makeLoad() })
    expect(signals[0].aborted).toBe(true)
    unmount()
    expect(signals[1].aborted).toBe(true)
  })

  it('reloads on demand and applies local mutations', async () => {
    let value = 1
    const load = vi.fn(async () => value)
    const { result } = renderHook(() => usePolledResource(load))
    await waitFor(() => expect(result.current.data).toBe(1))

    act(() => result.current.mutate((current) => (current ?? 0) + 10))
    expect(result.current.data).toBe(11)

    value = 2
    await act(() => result.current.reload())
    expect(result.current.data).toBe(2)
  })

  it('ignores a response that lands after a newer reload', async () => {
    // Deferred responses that ignore their abort signal, so only the request
    // id can keep the older one from committing.
    const pending: { resolve: (value: string) => void; reject: (error: Error) => void }[] = []
    const load = vi.fn(
      () =>
        new Promise<string>((resolve, reject) => {
          pending.push({ resolve, reject })
        }),
    )
    const { result } = renderHook(() => usePolledResource(load))
    await flush()
    await act(async () => pending[0].resolve('initial'))
    expect(result.current.data).toBe('initial')

    // A poll is in flight when the caller reloads.
    let reloaded: Promise<void> = Promise.resolve()
    act(() => void result.current.reload())
    act(() => {
      reloaded = result.current.reload()
    })
    expect(load).toHaveBeenCalledTimes(3)

    await act(async () => pending[2].resolve('after reload'))
    await act(() => reloaded)
    expect(result.current.data).toBe('after reload')

    await act(async () => pending[1].resolve('before reload'))
    expect(result.current.data).toBe('after reload')
    expect(result.current.refreshing).toBe(false)

    // A superseded request's failure is not the resource's error either.
    act(() => void result.current.reload())
    act(() => void result.current.reload())
    await act(async () => pending[4].resolve('latest'))
    await act(async () => pending[3].reject(new Error('late failure')))
    expect(result.current.data).toBe('latest')
    expect(result.current.error).toBeNull()
  })

  it('aborts the in-flight request when reloaded', async () => {
    const signals: AbortSignal[] = []
    const load = vi.fn((signal: AbortSignal) => {
      signals.push(signal)
      return new Promise<string>((resolve, reject) => {
        signal.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        )
        if (signals.length > 1) resolve(`response ${signals.length}`)
      })
    })
    const { result } = renderHook(() => usePolledResource(load))
    await flush()
    expect(result.current.loading).toBe(true)

    await act(() => result.current.reload())
    expect(signals[0].aborted).toBe(true)
    expect(signals[1].aborted).toBe(false)
    expect(result.current.data).toBe('response 2')
    expect(result.current.error).toBeNull()
    expect(result.current.loading).toBe(false)
    expect(result.current.refreshing).toBe(false)
  })

  it('fetches nothing while disabled', () => {
    const load = vi.fn(async () => 'data')
    const { result } = renderHook(() => usePolledResource(load, { enabled: false }))
    expect(load).not.toHaveBeenCalled()
    expect(result.current.loading).toBe(false)
  })
})
