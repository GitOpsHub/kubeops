import { useEffect, useState } from 'react'

/** The value, held back until it has stopped changing for `delayMs`. */
export function useDebouncedValue<T>(value: T, delayMs: number) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    if (Object.is(value, debounced)) return
    const timer = window.setTimeout(() => setDebounced(value), delayMs)
    return () => window.clearTimeout(timer)
  }, [debounced, delayMs, value])
  return debounced
}
