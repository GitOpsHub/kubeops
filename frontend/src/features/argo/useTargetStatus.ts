import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getTargetArgoStatus, type ArgoAppStatus, type ArgoOperation } from '../../api/argo'
import { usePolledResource } from '../../hooks/usePolledResource'
import { isInFlightPhase } from './operation-phases'

/**
 * Live Argo CD state per deployment target, polled adaptively: quickly while
 * an operation is running (or just after this browser started one, before
 * Argo CD has picked it up), slowly otherwise. Polling rather than a stream
 * survives serverless time limits, and everything stays behind this hook so a
 * stream can replace it later without touching the views.
 */

export const fastPollMs = 1_500
export const idlePollMs = 10_000
/** How long a sync this browser started counts as running before Argo shows it. */
export const triggerGraceMs = 15_000
// A trigger older than this cannot explain a finished operation.
const triggerMemoryMs = 5 * 60_000

type Options = {
  /** Called once when an operation reaches a terminal phase. */
  onSettled?: (targetId: string, operation: ArgoOperation) => void
}

type Seen = { phase: string; startedAt: string | null }

export function useTargetStatuses(
  onboardingId: string,
  targetIds: string[],
  { onSettled }: Options = {},
) {
  const key = targetIds.join(',')
  // One target failing should not blank the others, so each keeps its last
  // good status; only when every target fails does the poll count as failed.
  const lastGood = useRef(new Map<string, ArgoAppStatus>())
  const load = useCallback(
    async (signal: AbortSignal) => {
      const ids = key ? key.split(',') : []
      const settled = await Promise.allSettled(
        ids.map((id) => getTargetArgoStatus(onboardingId, id, signal)),
      )
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const firstError = settled.find((result) => result.status === 'rejected')
      if (ids.length > 0 && settled.every((result) => result.status === 'rejected')) {
        throw (firstError as PromiseRejectedResult).reason
      }
      const statuses: Record<string, ArgoAppStatus | undefined> = {}
      const errors: Record<string, Error | undefined> = {}
      ids.forEach((id, index) => {
        const result = settled[index]
        if (result.status === 'fulfilled') {
          lastGood.current.set(id, result.value)
          statuses[id] = result.value
        } else {
          statuses[id] = lastGood.current.get(id)
          errors[id] =
            result.reason instanceof Error ? result.reason : new Error(String(result.reason))
        }
      })
      return { statuses, errors }
    },
    [onboardingId, key],
  )

  const [boost, setBoost] = useState<{ token: number; active: boolean }>({
    token: 0,
    active: false,
  })
  const triggeredAt = useRef(0)
  useEffect(() => {
    if (!boost.active) return
    const timer = window.setTimeout(
      () => setBoost((current) => ({ ...current, active: false })),
      triggerGraceMs,
    )
    return () => window.clearTimeout(timer)
  }, [boost])

  // The cadence depends on what the last poll said, which the poll itself
  // returns, so it is mirrored into state once each response lands.
  const [running, setRunning] = useState(false)
  const query = usePolledResource(load, {
    intervalMs: running || boost.active ? fastPollMs : idlePollMs,
    enabled: Boolean(onboardingId) && targetIds.length > 0,
  })
  const statuses = useMemo(() => query.data?.statuses ?? {}, [query.data])
  const errors = useMemo(() => query.data?.errors ?? {}, [query.data])
  const anyRunning = targetIds.some((id) => isInFlightPhase(statuses[id]?.operation?.phase))
  useEffect(() => setRunning(anyRunning), [anyRunning])

  const onSettledRef = useRef(onSettled)
  useEffect(() => {
    onSettledRef.current = onSettled
  }, [onSettled])

  // Compares each poll with the one before it. The first observation of a
  // target only records it, so opening the page never announces old news.
  const seen = useRef(new Map<string, Seen>())
  useEffect(() => {
    if (!query.data) return
    for (const [id, status] of Object.entries(query.data.statuses)) {
      const operation = status?.operation
      const previous = seen.current.get(id)
      seen.current.set(id, {
        phase: operation?.phase ?? '',
        startedAt: operation?.startedAt ?? null,
      })
      if (!operation || !previous || isInFlightPhase(operation.phase)) continue
      const sameOperation = previous.startedAt === operation.startedAt
      const watchedToEnd = sameOperation && isInFlightPhase(previous.phase)
      // A quick sync can start and finish between two polls; it is ours if
      // this browser asked for one recently.
      const finishedUnseen = !sameOperation && Date.now() - triggeredAt.current < triggerMemoryMs
      if (watchedToEnd || finishedUnseen) onSettledRef.current?.(id, operation)
    }
  }, [query.data])

  const { reload } = query
  /** Poll fast for a while and now: a sync was just requested. */
  const expectOperation = useCallback(() => {
    triggeredAt.current = Date.now()
    setBoost((current) => ({ token: current.token + 1, active: true }))
    void reload()
  }, [reload])

  return {
    statuses,
    errors,
    loading: query.loading,
    error: query.error,
    reload: query.reload,
    running: anyRunning,
    polling: anyRunning || boost.active ? ('fast' as const) : ('idle' as const),
    expectOperation,
  }
}

/** One target's live Argo CD state; see `useTargetStatuses`. */
export function useTargetStatus(onboardingId: string, targetId: string, options: Options = {}) {
  const ids = useMemo(() => (targetId ? [targetId] : []), [targetId])
  const result = useTargetStatuses(onboardingId, ids, options)
  return {
    ...result,
    status: result.statuses[targetId],
    targetError: result.errors[targetId] ?? null,
  }
}
