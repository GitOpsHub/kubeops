import { vi } from 'vitest'
import type { PodLogEntry } from '../api/argo'
import type { ResourceContainer } from '../api/argo'

/** An NDJSON response the test writes into line by line, then closes. */
export type ControlledStream = {
  push: (...entries: PodLogEntry[]) => void
  close: () => void
}

type LogsFetchOptions = {
  containers?: ResourceContainer[]
  /** Answers the logs request with this status and `{error}` instead of a stream. */
  status?: number
}

/**
 * Stubs fetch for the log viewer alone: the container list, and one
 * controllable stream per logs request, so a test decides exactly when lines
 * arrive and when the server hangs up.
 */
export function mockLogsFetch({ containers = [], status }: LogsFetchOptions = {}) {
  const streams: ControlledStream[] = []
  const requests: URL[] = []
  const encoder = new TextEncoder()

  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname.endsWith('/resources/containers')) {
      return Response.json({ items: containers })
    }
    if (url.pathname.endsWith('/logs')) {
      requests.push(url)
      if (status) return Response.json({ error: 'refused' }, { status })
      let controller!: ReadableStreamDefaultController<Uint8Array>
      const body = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value
        },
      })
      streams.push({
        push: (...entries) =>
          controller.enqueue(
            encoder.encode(entries.map((entry) => `${JSON.stringify(entry)}\n`).join('')),
          ),
        close: () => controller.close(),
      })
      return new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } })
    }
    return Response.json({ error: 'not found' }, { status: 404 })
  })

  return { fetchMock, streams, requests }
}

/** Queues animation frames so a test can run them, and count them, on demand. */
export function stubAnimationFrames() {
  const frames = new Map<number, FrameRequestCallback>()
  let next = 1
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(next, callback)
    return next++
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  return {
    get pending() {
      return frames.size
    },
    run() {
      const queued = [...frames.values()]
      frames.clear()
      for (const callback of queued) callback(performance.now())
    },
  }
}

/** Lets fetch promises and stream reads settle. */
export function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
