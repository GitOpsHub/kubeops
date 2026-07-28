import { useCallback, useState } from 'react'

/**
 * A small preference that survives reloads. Storage is guarded because private
 * browsing, blocked storage, and this project's test environment all lack a
 * working `localStorage` — a preference that does not persist beats a crash.
 */
export function useStoredPreference<T extends string>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      return (window.localStorage.getItem(key) as T | null) ?? fallback
    } catch {
      return fallback
    }
  })

  const store = useCallback(
    (next: T) => {
      setValue(next)
      try {
        window.localStorage.setItem(key, next)
      } catch {
        // Keeps working for this session even when it cannot be remembered.
      }
    },
    [key],
  )

  return [value, store] as const
}
