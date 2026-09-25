import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockLogsFetch, settle, stubAnimationFrames } from '../../test/log-streams'
import { defaultReconnectDelaysMs, useLogStream, type LogStreamParams } from './useLogStream'

afterEach(() => {
  vi.restoreAllMocks()
})

const base: LogStreamParams = {
  onboardingId: 'onboarding-1',
  targetId: 'target-1',
  resource: { kind: 'Deployment', name: 'payments-api', namespace: 'payments' },
  reconnectDelaysMs: [5, 10, 20],
}

const at = (second: number) => `2026-08-04T12:00:0${second}Z`

describe('useLogStream', () => {
  it('backs off 1, 2, then 5 seconds by default', () => {
    expect(defaultReconnectDelaysMs).toEqual([1_000, 2_000, 5_000])
  })

  it('hands React one batch per animation frame', async () => {
    const frames = stubAnimationFrames()
    const { streams } = mockLogsFetch()
    const { result } = renderHook(() => useLogStream(base))
    await act(settle)
    expect(result.current.status).toBe('live')

    for (let index = 0; index < 50; index += 1) {
      streams[0].push({ timestamp: at(1), podName: 'a', content: `line ${index}` })
    }
    await act(settle)
    // Fifty lines arrived, but nothing renders until the frame, and only one
    // frame was asked for.
    expect(result.current.lines).toHaveLength(0)
    expect(frames.pending).toBe(1)

    act(() => frames.run())
    expect(result.current.lines).toHaveLength(50)
    expect(result.current.lines[49]).toMatchObject({ seq: 50, content: 'line 49' })
  })

  it('resumes a closed follow stream from the newest timestamp without duplicates', async () => {
    const { streams, requests } = mockLogsFetch()
    const { result } = renderHook(() => useLogStream({ ...base, tailLines: 100 }))
    await act(settle)
    expect(requests[0].searchParams.get('tailLines')).toBe('100')
    expect(requests[0].searchParams.has('sinceTime')).toBe(false)

    await act(async () => {
      streams[0].push(
        { timestamp: at(0), podName: 'a', content: 'first' },
        { timestamp: at(1), podName: 'a', content: 'second' },
        { timestamp: at(1), podName: 'b', content: 'second' },
      )
      // The serverless function hit its maximum duration.
      streams[0].close()
      await settle()
    })
    await waitFor(() => expect(requests).toHaveLength(2))

    const resumed = requests[1].searchParams
    expect(resumed.get('sinceTime')).toBe(at(1))
    expect(resumed.get('tailLines')).toBe('5000')
    expect(resumed.has('sinceSeconds')).toBe(false)

    await act(async () => {
      // Kubernetes replays the whole second the stream stopped in.
      streams[1].push(
        { timestamp: at(1), podName: 'a', content: 'second' },
        { timestamp: at(1), podName: 'b', content: 'second' },
        { timestamp: at(2), podName: 'a', content: 'third' },
      )
      await settle()
    })
    await waitFor(() => expect(result.current.lines).toHaveLength(4))
    expect(result.current.lines.map((line) => `${line.podName}:${line.content}`)).toEqual([
      'a:first',
      'a:second',
      'b:second',
      'a:third',
    ])
    expect(result.current.status).toBe('live')
  })

  it('reports reconnecting between streams', async () => {
    const { streams, requests } = mockLogsFetch()
    const { result } = renderHook(() => useLogStream({ ...base, reconnectDelaysMs: [60_000] }))
    await act(settle)
    await act(async () => {
      streams[0].close()
      await settle()
    })
    expect(result.current.status).toBe('reconnecting')
    expect(result.current.reconnectAttempt).toBe(1)
    expect(requests).toHaveLength(1)
  })

  it('does not resume a previous-container read, which never follows', async () => {
    const { streams, requests } = mockLogsFetch()
    const { result } = renderHook(() => useLogStream({ ...base, previous: true }))
    await act(settle)
    expect(requests[0].searchParams.get('previous')).toBe('true')
    expect(requests[0].searchParams.get('follow')).toBe('false')
    await act(async () => {
      streams[0].close()
      await settle()
    })
    expect(result.current.status).toBe('ended')
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)))
    expect(requests).toHaveLength(1)
  })

  it('stops on an error line instead of retrying', async () => {
    const { streams, requests } = mockLogsFetch()
    const { result } = renderHook(() => useLogStream(base))
    await act(settle)
    await act(async () => {
      streams[0].push({ error: 'container "app" is waiting to start' })
      await settle()
    })
    expect(result.current.status).toBe('error')
    expect(result.current.error).toEqual({ message: 'container "app" is waiting to start' })
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)))
    expect(requests).toHaveLength(1)
  })

  it('keeps the HTTP status of a refused request', async () => {
    mockLogsFetch({ status: 403 })
    const { result } = renderHook(() => useLogStream(base))
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.error?.status).toBe(403)
  })

  it('holds lines while paused and shows them on resume', async () => {
    const frames = stubAnimationFrames()
    const { streams } = mockLogsFetch()
    const { result, rerender } = renderHook((props: LogStreamParams) => useLogStream(props), {
      initialProps: { ...base, paused: true },
    })
    await act(settle)
    await act(async () => {
      streams[0].push({ content: 'one' }, { content: 'two' })
      await settle()
    })
    act(() => frames.run())
    expect(result.current.status).toBe('paused')
    expect(result.current.lines).toHaveLength(0)
    expect(result.current.held).toBe(2)

    rerender({ ...base, paused: false })
    act(() => frames.run())
    expect(result.current.lines.map((line) => line.content)).toEqual(['one', 'two'])
    expect(result.current.status).toBe('live')
  })

  it('aborts the stream on unmount and restarts it when the resource changes', async () => {
    const { requests, fetchMock } = mockLogsFetch()
    const { rerender, unmount } = renderHook((props: LogStreamParams) => useLogStream(props), {
      initialProps: base,
    })
    await act(settle)
    const firstSignal = fetchMock.mock.calls[0][1]?.signal as AbortSignal
    rerender({ ...base, resource: { kind: 'Pod', name: 'payments-api-abc' } })
    await act(settle)
    expect(firstSignal.aborted).toBe(true)
    expect(requests[1].searchParams.get('name')).toBe('payments-api-abc')

    const secondSignal = fetchMock.mock.calls[1][1]?.signal as AbortSignal
    unmount()
    expect(secondSignal.aborted).toBe(true)
  })
})
