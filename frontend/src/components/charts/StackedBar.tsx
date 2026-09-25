import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ChartTable } from './ChartTable'
import {
  colorVar,
  formatCount,
  formatPercent,
  percentOf,
  runningTotals,
  useEntrance,
} from './chart-utils'
import type { DonutSegment } from './Donut'
import './charts.css'

export type StackedBarSegment = DonutSegment

type Props = {
  segments: StackedBarSegment[]
  label: string
  /** The legend doubles as the accessible data; without it a hidden table stands in. */
  legend?: boolean
  formatValue?: (value: number) => string
  size?: 'sm' | 'md'
  /**
   * Just the bar, hidden from assistive tech: for a stat tile whose text
   * already states the numbers, where a table inside a link would be noise.
   */
  decorative?: boolean
}

/** One whole split into parts, e.g. applications by health. */
export function StackedBar({
  segments,
  label,
  legend = true,
  formatValue = formatCount,
  size = 'md',
  decorative = false,
}: Props) {
  const entering = useEntrance()
  const [active, setActive] = useState<string | null>(null)
  const clean = segments.map((segment) => ({
    ...segment,
    value: Number.isFinite(segment.value) && segment.value > 0 ? segment.value : 0,
  }))
  const total = clean.reduce((sum, segment) => sum + segment.value, 0)

  const nonEmpty = clean.filter((segment) => segment.value > 0)
  const shares = nonEmpty.map((segment) => percentOf(segment.value, total))
  const starts = runningTotals(shares)
  const drawn = nonEmpty.map((segment, index) => ({
    ...segment,
    share: shares[index],
    middle: starts[index] + shares[index] / 2,
  }))
  const hovered = drawn.find((segment) => segment.id === active)

  if (decorative) {
    return (
      <span className={`stacked-bar stacked-bar--${size}`} aria-hidden="true">
        <span className={entering ? 'stacked-bar-track is-entering' : 'stacked-bar-track'}>
          {drawn.map((segment) => (
            <span
              key={segment.id}
              className="stacked-bar-segment"
              style={{
                flexGrow: segment.value,
                background: colorVar(segment.color ?? segment.tone),
              }}
            />
          ))}
        </span>
      </span>
    )
  }

  return (
    <figure className={`stacked-bar stacked-bar--${size}`} aria-label={label}>
      <div className="stacked-bar-plot">
        <div
          className={entering ? 'stacked-bar-track is-entering' : 'stacked-bar-track'}
          aria-hidden="true"
        >
          {drawn.map((segment) => (
            <span
              key={segment.id}
              className={
                segment.id === active ? 'stacked-bar-segment is-active' : 'stacked-bar-segment'
              }
              style={{
                flexGrow: segment.value,
                background: colorVar(segment.color ?? segment.tone),
              }}
              onPointerEnter={() => setActive(segment.id)}
              onPointerLeave={() => setActive(null)}
            />
          ))}
        </div>
        {hovered && (
          <div
            className="chart-tooltip chart-tooltip--above"
            style={{ left: `${hovered.middle}%` }}
            aria-hidden="true"
          >
            <strong>{formatValue(hovered.value)}</strong>
            <span>
              {hovered.label} · {formatPercent(hovered.share)}
            </span>
          </div>
        )}
      </div>
      {legend ? (
        <ul className="chart-legend">
          {clean.map((segment) => {
            const body = (
              <>
                <span
                  className="chart-swatch"
                  style={{ background: colorVar(segment.color ?? segment.tone) }}
                  aria-hidden="true"
                />
                {segment.icon && (
                  <span className="chart-legend-icon" aria-hidden="true">
                    {segment.icon}
                  </span>
                )}
                <span className="chart-legend-label">{segment.label}</span>
                <span className="chart-legend-value">{formatValue(segment.value)}</span>
              </>
            )
            const highlight = {
              onPointerEnter: () => setActive(segment.id),
              onPointerLeave: () => setActive(null),
              onFocus: () => setActive(segment.id),
              onBlur: () => setActive(null),
            }
            return (
              <li key={segment.id}>
                {segment.href ? (
                  <Link className="chart-legend-item" to={segment.href} {...highlight}>
                    {body}
                  </Link>
                ) : (
                  <span className="chart-legend-item" {...highlight}>
                    {body}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      ) : (
        <ChartTable
          caption={label}
          headers={['Segment', 'Value', 'Share']}
          rows={clean.map((segment) => [
            segment.label,
            formatValue(segment.value),
            formatPercent(percentOf(segment.value, total)),
          ])}
        />
      )}
    </figure>
  )
}
