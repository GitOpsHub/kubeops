import { useId, type CSSProperties } from 'react'
import { colorVar, useEntrance, type ChartColor } from './chart-utils'
import { isFiniteNumber, linearScale } from './scale'
import './charts.css'

type Props = {
  /** Oldest first. A null is a gap: a day with nothing to measure. */
  values: (number | null)[]
  label: string
  tone?: ChartColor
  height?: number
  formatValue?: (value: number) => string
}

// Drawn in a fixed box and stretched to the container; the stroke keeps its
// width through `vector-effect`, so only the geometry scales.
const boxWidth = 100
const inset = 3

/** A trend without axes, for a stat tile. Its summary is the accessible name. */
export function Sparkline({
  values,
  label,
  tone = 'accent',
  height = 32,
  formatValue = String,
}: Props) {
  const clipId = useId()
  const entering = useEntrance()
  const finite = values.filter(isFiniteNumber)
  const summary = describe(finite, formatValue)

  const low = Math.min(...finite)
  const high = Math.max(...finite)
  const y = linearScale([low, high], [height - inset, inset])
  const x = (index: number) =>
    values.length <= 1 ? boxWidth / 2 : (index / (values.length - 1)) * boxWidth
  const runs = segments(values)
  // One reading has no slope to draw, so it reads as a level line.
  const single = finite.length === 1
  const line = single
    ? `M0 ${height / 2}H${boxWidth}`
    : runs
        .map((run) =>
          run.map(([index, value], at) => `${at ? 'L' : 'M'}${x(index)} ${y(value)}`).join(''),
        )
        .join('')
  const area = single
    ? ''
    : runs
        .filter((run) => run.length > 1)
        .map(
          (run) =>
            `M${x(run[0][0])} ${height}` +
            run.map(([index, value]) => `L${x(index)} ${y(value)}`).join('') +
            `L${x(run[run.length - 1][0])} ${height}Z`,
        )
        .join('')

  return (
    <span className="sparkline" role="img" aria-label={`${label}. ${summary}`}>
      <svg
        viewBox={`0 0 ${boxWidth} ${height}`}
        preserveAspectRatio="none"
        width="100%"
        height={height}
        aria-hidden="true"
        focusable="false"
        style={{ '--series': colorVar(tone) } as CSSProperties}
      >
        {entering && (
          <clipPath id={clipId}>
            <rect className="chart-reveal" width={boxWidth} height={height} />
          </clipPath>
        )}
        {finite.length > 0 && (
          <g clipPath={entering ? `url(#${clipId})` : undefined}>
            {area && <path className="sparkline-area" d={area} />}
            <path className="sparkline-line" d={line} vectorEffect="non-scaling-stroke" />
          </g>
        )}
      </svg>
    </span>
  )
}

/** Contiguous runs of finite values, each as [index, value] pairs. */
function segments(values: (number | null)[]) {
  const runs: [number, number][][] = []
  let current: [number, number][] = []
  values.forEach((value, index) => {
    if (isFiniteNumber(value)) {
      current.push([index, value])
    } else if (current.length) {
      runs.push(current)
      current = []
    }
  })
  if (current.length) runs.push(current)
  return runs
}

function describe(values: number[], format: (value: number) => string) {
  if (values.length === 0) return 'No data.'
  const first = values[0]
  const last = values[values.length - 1]
  if (values.length === 1) return `${format(last)}.`
  return `From ${format(first)} to ${format(last)}; low ${format(Math.min(...values))}, high ${format(Math.max(...values))}.`
}
