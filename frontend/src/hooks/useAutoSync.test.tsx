import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildSyncRun } from '../test/mock-api'
import { useAutoSync } from './useAutoSync'

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state })
  document.dispatchEvent(new Event('visibilitychange'))
}

const flush = () => act(async () => {})

function stubRefresh(...responses: Array<{ items: unknown[]; intervalSeconds: number } | Error>) {
  const calls: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (request, init) => {
    calls.push(`${init?.method} ${new URL(String(request)).pathname}`)
    const next = responses.length > 1 ? responses.shift()! : responses[0]
    if (next instanceof Error) return Response.json({ error: next.message }, { status: 500 })
    return Response.json(next)
  })
  return calls
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  setVisibility('visible')
})

describe('useAutoSync', () => {
  it('refreshes stale sources on mount and notifies when something synced', async () => {
    const calls = stubRefresh({ items: [buildSyncRun({ trigger: 'auto' })], intervalSeconds: 300 })
    const onSynced = vi.fn()
    const { result } = renderHook(() => useAutoSync(onSynced))

    expect(result.current.syncing).toBe(true)
    await flush()
    expect(calls).toEqual(['POST /api/cloud-sources/refresh'])
    expect(result.current.syncing).toBe(false)
    expect(result.current.lastSyncedAt).not.toBeNull()
    expect(onSynced).toHaveBeenCalledTimes(1)
  })

  it('stays quiet when every source was already fresh', async () => {
    stubRefresh({ items: [], intervalSeconds: 300 })
    const onSynced = vi.fn()
    const { result } = renderHook(() => useAutoSync(onSynced))
    await flush()
    expect(result.current.lastSyncedAt).toBeNull()
    expect(onSynced).not.toHaveBeenCalled()
  })

  it('repeats on the interval the API reports', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const calls = stubRefresh({ items: [], intervalSeconds: 120 })
    renderHook(() => useAutoSync())
    await flush()
    expect(calls).toHaveLength(1)

    await act(async () => vi.advanceTimersByTime(119_000))
    expect(calls).toHaveLength(1)
    await act(async () => vi.advanceTimersByTime(1_000))
    expect(calls).toHaveLength(2)
  })

  it('never polls faster than once a minute', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const calls = stubRefresh({ items: [], intervalSeconds: 1 })
    renderHook(() => useAutoSync())
    await flush()
    await act(async () => vi.advanceTimersByTime(59_000))
    expect(calls).toHaveLength(1)
    await act(async () => vi.advanceTimersByTime(1_000))
    expect(calls).toHaveLength(2)
  })

  it('skips while hidden and catches up when the tab returns', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const calls = stubRefresh({ items: [], intervalSeconds: 60 })
    renderHook(() => useAutoSync())
    await flush()

    setVisibility('hidden')
    await act(async () => vi.advanceTimersByTime(180_000))
    expect(calls).toHaveLength(1)

    await act(async () => setVisibility('visible'))
    await flush()
    expect(calls).toHaveLength(2)
  })

  it('reports a failure and recovers on the next success', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    stubRefresh(new Error('database unavailable'), { items: [], intervalSeconds: 300 })
    const { result } = renderHook(() => useAutoSync())
    await flush()
    expect(result.current.error?.message).toBe('database unavailable')

    await act(async () => vi.advanceTimersByTime(300_000))
    await flush()
    expect(result.current.error).toBeNull()
  })
})
