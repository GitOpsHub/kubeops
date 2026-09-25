import { useCallback, useEffect, useRef, useState } from 'react'
import { isAbortError } from '../api/client'

/**
 * Loads a resource, keeps it fresh on an interval, and reports enough state for
 * a page to render loading, stale-with-error, and quiet-refresh views without
 * each page hand-rolling AbortControllers and interval bookkeeping.
 *
 * - `loading` is true only while nothing has loaded yet; once data exists every
 *   later request is a `refreshing` one, so the page never swaps content for a
 *   spinner mid-session.
 * - Polling pauses while the tab is hidden and catches up when it returns.
 * - After a failure the cadence backs off (1×, 2×, 4× … the interval, capped),
 *   so an unreachable API is not hammered by every open tab.
 *
 * `load` must be referentially stable (wrap it in `useCallback`); a new `load`
 * is treated as a new query and triggers an immediate fetch. A new
 * `intervalMs` is not: it only reschedules the timer, keeping the data, the
 * in-flight request, and any backoff, so a view can poll faster while
 * something is in flight without refetching each time it switches. Polling
 * counts interval ticks rather than timestamps so it stays deterministic under
 * fake timers.
 */

export type PolledResource<T> = {
  data: T | undefined
  error: Error | null
  loading: boolean
  refreshing: boolean
  lastUpdated: number | null
  /** Refetches now. Resolves once the request settles; never rejects. */
  reload: () => Promise<void>
  /** Applies a local update, e.g. the record a mutation returned. */
  mutate: (update: (current: T | undefined) => T | undefined) => void
}

type Options = {
  /** Polling cadence. Omit for a one-shot load. */
  intervalMs?: number
  /** When false nothing is fetched, e.g. while a required id is missing. */
  enabled?: boolean
}

const maxBackoffTicks = 8

type State<T> = {
  data: T | undefined
  error: Error | null
  lastUpdated: number | null
}

export function usePolledResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  { intervalMs, enabled = true }: Options = {},
): PolledResource<T> {
  const [state, setState] = useState<State<T>>({
    data: undefined,
    error: null,
    lastUpdated: null,
  })
  const [pending, setPending] = useState(0)
  const runRef = useRef<(() => Promise<void>) | null>(null)
  const tickRef = useRef<(() => void) | null>(null)
  // Read by the visibility catch-up, which lives with the query rather than
  // the timer and so must see the interval without depending on it.
  const intervalRef = useRef(intervalMs)
  useEffect(() => {
    intervalRef.current = intervalMs
  }, [intervalMs])

  useEffect(() => {
    if (!enabled) return
    let disposed = false
    let inFlight = 0
    let failures = 0
    let ticksToSkip = 0
    let lastSuccess = 0
    let latest = 0
    const controllers = new Set<AbortController>()

    // Only the newest request may commit. Timer and visibility runs never
    // overlap one in flight, but a reload does, and it must win: a caller
    // reloads because what it is about to read has changed (a sync it just
    // started), so an older response landing afterwards would show state from
    // before that change. Aborting the older request saves the round trip; the
    // id check also covers a loader that ignores its signal.
    const run = async () => {
      const id = ++latest
      for (const controller of controllers) controller.abort()
      const controller = new AbortController()
      controllers.add(controller)
      inFlight += 1
      setPending((count) => count + 1)
      try {
        const data = await load(controller.signal)
        if (disposed || id !== latest) return
        failures = 0
        ticksToSkip = 0
        lastSuccess = Date.now()
        setState({ data, error: null, lastUpdated: lastSuccess })
      } catch (error) {
        if (disposed || id !== latest || isAbortError(error)) return
        failures += 1
        ticksToSkip = Math.min(maxBackoffTicks, 2 ** (failures - 1) - 1)
        setState((current) => ({
          ...current,
          error: error instanceof Error ? error : new Error(String(error)),
        }))
      } finally {
        controllers.delete(controller)
        inFlight -= 1
        if (!disposed) setPending((count) => count - 1)
      }
    }
    runRef.current = run
    void run()

    const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'

    tickRef.current = () => {
      if (hidden() || inFlight > 0) return
      if (ticksToSkip > 0) {
        ticksToSkip -= 1
        return
      }
      void run()
    }

    // Catch up at once when the tab returns, rather than waiting out the
    // remainder of an interval that was paused.
    const handleVisibility = () => {
      const every = intervalRef.current
      if (hidden() || inFlight > 0 || !every) return
      if (Date.now() - lastSuccess >= every) void run()
    }
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      disposed = true
      for (const controller of controllers) controller.abort()
      document.removeEventListener('visibilitychange', handleVisibility)
      runRef.current = null
      tickRef.current = null
      // Requests aborted above never reach their own decrement.
      setPending(0)
    }
  }, [enabled, load])

  // The timer is separate from the query so a new cadence restarts only the
  // clock. It still restarts with a new query, as it always has, so the first
  // tick of a new query is a full interval after its initial fetch.
  useEffect(() => {
    if (!enabled || !intervalMs) return
    const interval = window.setInterval(() => tickRef.current?.(), intervalMs)
    return () => window.clearInterval(interval)
  }, [enabled, intervalMs, load])

  const reload = useCallback(() => runRef.current?.() ?? Promise.resolve(), [])

  const mutate = useCallback((update: (current: T | undefined) => T | undefined) => {
    setState((current) => ({ ...current, data: update(current.data) }))
  }, [])

  const busy = pending > 0
  return {
    data: state.data,
    error: state.error,
    // True before the first request is even issued, so a page never flashes
    // its empty state on the initial render.
    loading: state.data === undefined && (busy || (enabled && state.error === null)),
    refreshing: busy && state.data !== undefined,
    lastUpdated: state.lastUpdated,
    reload,
    mutate,
  }
}
