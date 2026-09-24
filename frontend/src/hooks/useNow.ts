import { useSyncExternalStore } from 'react'

const tickMs = 15_000
const listeners = new Set<() => void>()
let now = Date.now()
let timer: number | undefined

function subscribe(onChange: () => void) {
  listeners.add(onChange)
  if (timer === undefined) {
    now = Date.now()
    timer = window.setInterval(() => {
      now = Date.now()
      listeners.forEach((listener) => listener())
    }, tickMs)
  }
  return () => {
    listeners.delete(onChange)
    if (listeners.size === 0) {
      window.clearInterval(timer)
      timer = undefined
    }
  }
}

/**
 * A clock shared by every relative time on screen. One interval serves them
 * all, so a table of fifty "3m ago" cells re-renders together on one tick
 * instead of drifting apart on fifty timers.
 */
export function useNow() {
  return useSyncExternalStore(
    subscribe,
    () => now,
    () => now,
  )
}
