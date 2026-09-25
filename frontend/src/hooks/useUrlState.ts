import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

export type UrlStateUpdate<K extends string> = Partial<Record<K, string | number | boolean>>

/**
 * A set of string values kept in the query string, so a filtered view can be
 * bookmarked, shared, and linked to (the overview's "Needs attention" links
 * land on pre-filtered lists this way).
 *
 * A value equal to its default is removed from the URL rather than written, so
 * the plain route stays the canonical unfiltered view. Writes replace the
 * history entry: stepping through filters should not fill the back button.
 * Keys outside `defaults` are left alone, which lets two owners share a URL.
 */
export function useUrlState<K extends string>(defaults: Record<K, string>) {
  const [searchParams, setSearchParams] = useSearchParams()
  // Callers pass literals; holding the first one keeps `update` stable.
  const [initial] = useState(defaults)
  // The router's setter changes identity with every URL change; reading it
  // through a ref keeps `update` stable, so effects depending on it do not
  // re-run on each write.
  const setRef = useRef(setSearchParams)
  useLayoutEffect(() => {
    setRef.current = setSearchParams
  })

  const values = useMemo(() => {
    const result = { ...initial }
    for (const key of Object.keys(result) as K[]) {
      const value = searchParams.get(key)
      if (value !== null) result[key] = value
    }
    return result
  }, [initial, searchParams])

  const update = useCallback(
    (changes: UrlStateUpdate<K>) => {
      setRef.current(
        (current) => {
          const next = new URLSearchParams(current)
          for (const [key, raw] of Object.entries(changes) as [K, string | number | boolean][]) {
            const value = raw === false ? '' : raw === true ? 'true' : String(raw ?? '')
            if (value === '' || value === initial[key]) next.delete(key)
            else next.set(key, value)
          }
          return next
        },
        { replace: true },
      )
    },
    [initial],
  )

  return [values, update] as const
}
