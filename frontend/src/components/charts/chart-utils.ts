import { useEffect, useRef, useState } from 'react'
import type { Tone } from '../../lib/status'

/**
 * A mark's colour, always a token: a status tone when the colour means
 * good/bad, a categorical slot when it only tells series apart. Charts never
 * take a raw colour, so both themes and forced colours stay correct.
 */
export type ChartColor = Tone | 'accent' | `chart-${1 | 2 | 3 | 4 | 5 | 6}`

export function colorVar(color: ChartColor | undefined) {
  if (!color) return 'var(--chart-1)'
  if (color === 'accent') return 'var(--accent)'
  if (color.startsWith('chart-')) return `var(--${color})`
  return `var(--${color}-solid)`
}

/** Categorical slots in their fixed order; the nth entity always gets the nth. */
export function chartSlot(index: number): ChartColor {
  return `chart-${((index % 6) + 1) as 1 | 2 | 3 | 4 | 5 | 6}`
}

const entranceMs = 900

/**
 * True for the first moments after a chart mounts, which is the only time it
 * draws in. Marks added by a later poll arrive after this flips, so a refresh
 * never replays the animation.
 */
export function useEntrance() {
  const [entering, setEntering] = useState(true)
  useEffect(() => {
    const timer = window.setTimeout(() => setEntering(false), entranceMs)
    return () => window.clearTimeout(timer)
  }, [])
  return entering
}

/**
 * The element's rendered width, so an SVG can be drawn at 1:1 and its text
 * does not scale with the card. Falls back to `initial` where layout is not
 * measured (tests, the first paint).
 */
export function useElementWidth<T extends HTMLElement>(initial: number) {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(initial)
  useEffect(() => {
    const element = ref.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      const measured = Math.round(entry.contentRect.width)
      if (measured > 0) setWidth(measured)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })

export function formatCount(value: number) {
  return Math.abs(value) >= 10_000 ? compact.format(value) : value.toLocaleString()
}

export function percentOf(value: number, total: number) {
  if (!total || !Number.isFinite(value)) return 0
  return (value / total) * 100
}

/** "33%", or "<1%" for a sliver that would otherwise read as nothing. */
export function formatPercent(value: number) {
  if (value > 0 && value < 1) return '<1%'
  return `${Math.round(value)}%`
}

/** Where each value starts when laid end to end: [2, 3, 5] → [0, 2, 5]. */
export function runningTotals(values: number[]) {
  const starts: number[] = []
  let sum = 0
  for (const value of values) {
    starts.push(sum)
    sum += value
  }
  return starts
}
