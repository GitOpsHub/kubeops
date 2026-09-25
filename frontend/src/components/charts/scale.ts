/**
 * The handful of scale helpers the charts need, so no chart library is pulled
 * in for data this small. Every function tolerates empty and degenerate input
 * (one value, all zeros, NaN) and never returns a non-finite coordinate: an
 * SVG path with "NaN" in it silently draws nothing.
 */

export type LinearScale = {
  (value: number): number
  domain: [number, number]
  range: [number, number]
}

export type BandScale = {
  (key: string): number
  keys: string[]
  /** Width of one band, after inner padding. */
  bandwidth: number
  /** Distance from one band's start to the next. */
  step: number
  index: (key: string) => number
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function linearScale(domain: [number, number], range: [number, number]): LinearScale {
  const [d0, d1] = domain.map((value) => (isFiniteNumber(value) ? value : 0)) as [number, number]
  const [r0, r1] = range
  // A flat domain (every value equal) would divide by zero; draw it mid-range.
  const span = d1 - d0
  const scale = ((value: number) => {
    if (!isFiniteNumber(value)) return r0
    if (span === 0) return (r0 + r1) / 2
    return r0 + ((value - d0) / span) * (r1 - r0)
  }) as LinearScale
  scale.domain = [d0, d1]
  scale.range = range
  return scale
}

export function bandScale(
  keys: string[],
  range: [number, number],
  { paddingInner = 0.2, paddingOuter = 0.1 } = {},
): BandScale {
  const [r0, r1] = range
  const count = keys.length
  const step = count === 0 ? 0 : (r1 - r0) / Math.max(1, count - paddingInner + paddingOuter * 2)
  const bandwidth = Math.max(0, step * (1 - paddingInner))
  const positions = new Map(keys.map((key, index) => [key, index]))
  const index = (key: string) => positions.get(key) ?? -1
  const scale = ((key: string) => {
    const at = index(key)
    return at < 0 ? r0 : r0 + step * paddingOuter + at * step
  }) as BandScale
  scale.keys = keys
  scale.bandwidth = bandwidth
  scale.step = step
  scale.index = index
  return scale
}

/** A linear scale over timestamps; accepts Dates or milliseconds. */
export function timeScale(domain: [Date, Date], range: [number, number]) {
  const linear = linearScale([domain[0].getTime(), domain[1].getTime()], range)
  return (value: Date | number) => linear(typeof value === 'number' ? value : value.getTime())
}

/**
 * Round tick values covering [min, max] with roughly `count` intervals, on
 * steps of 1, 2, 5 × 10ⁿ so an axis reads 0 / 5 / 10 rather than 0 / 3.7 / 7.4.
 * The returned bounds are the outer ticks, which the scale's domain should use.
 */
export function niceTicks(min: number, max: number, count = 4, { integer = false } = {}) {
  let low = isFiniteNumber(min) ? min : 0
  let high = isFiniteNumber(max) ? max : 0
  if (low > high) [low, high] = [high, low]
  if (low === high) {
    // A flat series still needs an axis: anchor it at zero so the value reads
    // as a magnitude, and give an all-zero series a unit of headroom.
    low = Math.min(0, low)
    high = Math.max(0, high) || 1
  }
  const rough = niceStep((high - low) / Math.max(1, count))
  // Counts have no half-runs; an integer axis never steps below 1.
  const step = integer ? Math.max(1, rough) : rough
  const start = Math.floor(low / step) * step
  const end = Math.ceil(high / step) * step
  const ticks: number[] = []
  // Counting in integers avoids drift such as 0.30000000000000004.
  const intervals = Math.round((end - start) / step)
  for (let index = 0; index <= intervals; index += 1) {
    ticks.push(roundTo(start + index * step, step))
  }
  return { ticks, min: start, max: end, step }
}

function niceStep(rough: number) {
  if (!isFiniteNumber(rough) || rough <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const residual = rough / magnitude
  const nice = residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 5 ? 5 : 10
  return nice * magnitude
}

function roundTo(value: number, step: number) {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)))
  return Number(value.toFixed(decimals))
}

/** Evenly spaced indexes to label on a crowded axis, always keeping the last. */
export function tickIndexes(count: number, maxLabels: number) {
  if (count <= 0) return []
  if (count <= maxLabels) return Array.from({ length: count }, (_, index) => index)
  const every = Math.ceil(count / maxLabels)
  const indexes: number[] = []
  for (let index = count - 1; index >= 0; index -= every) indexes.unshift(index)
  return indexes
}
