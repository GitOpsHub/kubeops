import { useEffect, useRef, useState } from 'react'

/**
 * True for a moment after `value` changes — never on first render, so a page
 * load or a poll that brings the same value stays still, and only a real
 * transition (say, Progressing → Healthy) draws the eye.
 */
export function useChangeFlash(value: string, durationMs = 600) {
  const previous = useRef(value)
  const [flashing, setFlashing] = useState(false)
  useEffect(() => {
    if (previous.current === value) return
    previous.current = value
    setFlashing(true)
    const timer = window.setTimeout(() => setFlashing(false), durationMs)
    return () => window.clearTimeout(timer)
  }, [value, durationMs])
  return flashing
}
