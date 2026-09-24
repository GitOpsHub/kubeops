import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { useMediaQuery } from './useMediaQuery'

export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

export const themeStorageKey = 'kubeops-theme'

const listeners = new Set<() => void>()

// Only used when storage throws, so a choice still holds for the session in
// private browsing instead of silently snapping back.
let sessionPreference: ThemePreference | null = null

function isPreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system'
}

function readPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(themeStorageKey)
    return isPreference(stored) ? stored : (sessionPreference ?? 'system')
  } catch {
    return sessionPreference ?? 'system'
  }
}

function subscribe(onChange: () => void) {
  listeners.add(onChange)
  // Another tab changing the theme should restyle this one too.
  const onStorage = (event: StorageEvent) => {
    if (event.key === themeStorageKey) onChange()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(onChange)
    window.removeEventListener('storage', onStorage)
  }
}

function writePreference(next: ThemePreference) {
  try {
    window.localStorage.setItem(themeStorageKey, next)
    sessionPreference = null
  } catch {
    sessionPreference = next
  }
  listeners.forEach((listener) => listener())
}

/**
 * The theme the user chose (light, dark, or follow the system) and what that
 * resolves to right now. Nothing stored means "system". The resolved value is
 * always written to `html[data-theme]`, because the token sheet derives its
 * colour scheme from the attribute; the pre-paint script in index.html writes
 * the same value before React mounts.
 *
 * State lives in a module-level store rather than per hook, so the theme menu,
 * the command palette, and anything else reading it can never disagree.
 */
export function useTheme() {
  const preference = useSyncExternalStore(subscribe, readPreference, () => 'system' as const)
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)')
  const resolved: ResolvedTheme =
    preference === 'system' ? (systemDark ? 'dark' : 'light') : preference

  useEffect(() => {
    document.documentElement.dataset.theme = resolved
  }, [resolved])

  const setPreference = useCallback((next: ThemePreference) => writePreference(next), [])

  return { preference, resolved, setPreference }
}
