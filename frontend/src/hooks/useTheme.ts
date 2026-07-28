import { useCallback, useEffect, useState } from 'react'

export type Theme = 'light' | 'dark'

export const themeStorageKey = 'kubeops-theme'

/** Absent in jsdom and some embedded webviews, so every use goes through here. */
function darkQuery(): MediaQueryList | null {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null
}

function systemTheme(): Theme {
  return darkQuery()?.matches ? 'dark' : 'light'
}

function storedTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(themeStorageKey)
    return value === 'light' || value === 'dark' ? value : null
  } catch {
    // Private browsing and blocked storage both throw; the system preference
    // is a fine answer in that case.
    return null
  }
}

/**
 * Resolves the active theme from the stored choice, falling back to the system
 * preference, and writes it to `data-theme` so the token layer can override the
 * `prefers-color-scheme` defaults in both directions.
 */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => storedTheme() ?? systemTheme())
  const [explicit, setExplicit] = useState(() => storedTheme() !== null)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  // Keep following the system while the user has not made a choice.
  useEffect(() => {
    if (explicit) return
    const query = darkQuery()
    if (!query) return
    const handleChange = () => setTheme(query.matches ? 'dark' : 'light')
    query.addEventListener('change', handleChange)
    return () => query.removeEventListener('change', handleChange)
  }, [explicit])

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next = current === 'dark' ? 'light' : 'dark'
      try {
        window.localStorage.setItem(themeStorageKey, next)
      } catch {
        // A theme that does not survive reload still beats a crash.
      }
      return next
    })
    setExplicit(true)
  }, [])

  return { theme, toggle }
}
