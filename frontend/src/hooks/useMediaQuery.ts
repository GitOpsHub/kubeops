import { useCallback, useSyncExternalStore } from 'react'

/** Absent in jsdom and some embedded webviews, so every use goes through here. */
function queryList(query: string): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query)
    : null
}

/**
 * Whether a media query currently matches, re-rendering when it flips. Where
 * `matchMedia` is unavailable the answer is `false`, the same as a browser
 * that reports no preference and a wide viewport.
 */
export function useMediaQuery(query: string) {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = queryList(query)
      if (!list) return () => {}
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    [query],
  )
  return useSyncExternalStore(
    subscribe,
    () => queryList(query)?.matches ?? false,
    () => false,
  )
}
