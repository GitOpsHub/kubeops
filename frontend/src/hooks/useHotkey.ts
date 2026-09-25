import { useEffect, useRef } from 'react'

/** Whether shortcuts should be printed with ⌘ rather than Ctrl. */
export function isApplePlatform() {
  if (typeof navigator === 'undefined') return false
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    ''
  return /mac|iphone|ipad|ipod/i.test(platform)
}

/** The modifier key's printed form, for `Kbd` hints beside a shortcut. */
export function modifierKeyLabel() {
  return isApplePlatform() ? '⌘' : 'Ctrl'
}

type Options = {
  enabled?: boolean
}

/**
 * Calls `handler` for a `mod+<key>` chord anywhere on the page. `mod` accepts
 * either ⌘ or Ctrl on every platform: people switch keyboards, and a Linux
 * user pressing ⌘ (Super) is rarer than a Mac user reaching for Ctrl. The
 * chord works from inside text fields too — that is the point of a global
 * shortcut — and the browser default (Ctrl+K focuses the address bar in some
 * browsers) is suppressed.
 */
export function useHotkey(key: string, handler: (event: KeyboardEvent) => void, options?: Options) {
  const enabled = options?.enabled ?? true
  // The latest handler without re-binding the listener on every render.
  const handlerRef = useRef(handler)
  useEffect(() => {
    handlerRef.current = handler
  })

  useEffect(() => {
    if (!enabled) return
    const wanted = key.toLowerCase()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() !== wanted) return
      event.preventDefault()
      handlerRef.current(event)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled, key])
}
