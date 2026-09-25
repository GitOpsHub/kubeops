import { useEffect, useRef, useState } from 'react'
import type { ResourceNode } from '../../api/onboarding'
import { normalise } from '../../lib/status'

/** Matches `--dur-flash`: long enough to catch the eye, short enough to not nag. */
export const healthFlashMs = 600

/**
 * The uids whose health changed since the previous poll, each for
 * `healthFlashMs`. The first set of nodes only records a baseline: a page
 * that has just opened has nothing to announce, and a resource that has just
 * appeared has no earlier health to change from.
 */
export function useHealthFlash(nodes: ResourceNode[], durationMs = healthFlashMs) {
  const previous = useRef<Map<string, string> | null>(null)
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const [changed, setChanged] = useState<ReadonlySet<string>>(() => new Set())

  useEffect(() => {
    const before = previous.current
    const now = new Map(nodes.map((node) => [node.uid, normalise(node.healthStatus)]))
    previous.current = now
    if (!before) return

    const flipped = [...now]
      .filter(([uid, health]) => before.has(uid) && before.get(uid) !== health)
      .map(([uid]) => uid)
    if (flipped.length === 0) return

    setChanged((current) => new Set([...current, ...flipped]))
    for (const uid of flipped) {
      // A second change inside the window restarts it rather than cutting it short.
      clearTimeout(timers.current.get(uid))
      timers.current.set(
        uid,
        setTimeout(() => {
          timers.current.delete(uid)
          setChanged((current) => {
            const next = new Set(current)
            next.delete(uid)
            return next
          })
        }, durationMs),
      )
    }
  }, [nodes, durationMs])

  useEffect(() => {
    const pending = timers.current
    return () => pending.forEach((timer) => clearTimeout(timer))
  }, [])

  return changed
}
