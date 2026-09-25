import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArgoAppStatus } from '../../api/argo'
import { buildArgoStatus, buildOperation } from '../../test/mock-api'
import { fastPollMs, idlePollMs, triggerGraceMs, useTargetStatus } from './useTargetStatus'

/** Settles pending promises; `waitFor` cannot poll while timers are faked. */
const flush = () => act(async () => {})
const advance = (ms: number) => act(async () => vi.advanceTimersByTime(ms))

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function stubStatus(initial: ArgoAppStatus) {
  let current = initial
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => Response.json(current))
  return {
    fetchMock,
    set: (next: ArgoAppStatus) => {
      current = next
    },
  }
}

describe('useTargetStatus', () => {
  it('polls quickly while an operation runs and announces how it ended', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    const api = stubStatus(buildArgoStatus())
    const onSettled = vi.fn()
    const { result } = renderHook(() => useTargetStatus('onboarding-1', 'target-1', { onSettled }))
    await flush()
    expect(api.fetchMock).toHaveBeenCalledTimes(1)
    expect(String(api.fetchMock.mock.calls[0][0])).toContain(
      '/application-onboardings/onboarding-1/targets/target-1/argo',
    )
    expect(result.current.polling).toBe('idle')

    // Idle: nothing until the slow interval.
    await advance(fastPollMs)
    expect(api.fetchMock).toHaveBeenCalledTimes(1)
    api.set(buildArgoStatus(undefined, { operation: buildOperation({ phase: 'Running' }) }))
    await advance(idlePollMs - fastPollMs)
    expect(api.fetchMock).toHaveBeenCalledTimes(2)
    expect(result.current.running).toBe(true)
    expect(result.current.polling).toBe('fast')

    // Running: every 1.5s.
    await advance(fastPollMs)
    expect(api.fetchMock).toHaveBeenCalledTimes(3)
    expect(onSettled).not.toHaveBeenCalled()

    api.set(
      buildArgoStatus(undefined, {
        operation: buildOperation({ phase: 'Succeeded', finishedAt: new Date().toISOString() }),
      }),
    )
    await advance(fastPollMs)
    expect(api.fetchMock).toHaveBeenCalledTimes(4)
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(onSettled.mock.calls[0][0]).toBe('target-1')
    expect(onSettled.mock.calls[0][1].phase).toBe('Succeeded')
    expect(result.current.polling).toBe('idle')

    // Settled: back to the slow cadence, and no second announcement.
    await advance(fastPollMs)
    expect(api.fetchMock).toHaveBeenCalledTimes(4)
    await advance(idlePollMs)
    expect(api.fetchMock).toHaveBeenCalledTimes(5)
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('polls quickly for a grace period after a sync is requested', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    const api = stubStatus(buildArgoStatus())
    const { result } = renderHook(() => useTargetStatus('onboarding-1', 'target-1'))
    await flush()
    expect(api.fetchMock).toHaveBeenCalledTimes(1)

    act(() => result.current.expectOperation())
    await flush()
    // Refetches at once, then keeps the fast cadence while Argo CD catches up.
    expect(api.fetchMock).toHaveBeenCalledTimes(2)
    expect(result.current.polling).toBe('fast')
    await advance(fastPollMs)
    expect(api.fetchMock).toHaveBeenCalledTimes(3)

    await advance(triggerGraceMs)
    expect(result.current.polling).toBe('idle')
    const settledCalls = api.fetchMock.mock.calls.length
    await advance(fastPollMs)
    expect(api.fetchMock).toHaveBeenCalledTimes(settledCalls)
  })

  it('announces an operation that started and finished between two polls it asked for', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    const api = stubStatus(
      buildArgoStatus(undefined, {
        operation: buildOperation({ phase: 'Succeeded', startedAt: '2026-01-01T00:00:00Z' }),
      }),
    )
    const onSettled = vi.fn()
    const { result } = renderHook(() => useTargetStatus('onboarding-1', 'target-1', { onSettled }))
    await flush()
    // The operation that had already finished before the page opened is old news.
    expect(onSettled).not.toHaveBeenCalled()

    api.set(
      buildArgoStatus(undefined, {
        operation: buildOperation({ phase: 'Failed', startedAt: new Date().toISOString() }),
      }),
    )
    act(() => result.current.expectOperation())
    await flush()
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(onSettled.mock.calls[0][1].phase).toBe('Failed')
  })
})
