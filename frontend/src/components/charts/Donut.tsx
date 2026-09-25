import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  colorVar,
  formatCount,
  formatPercent,
  percentOf,
  runningTotals,
  useEntrance,
  type ChartColor,
} from './chart-utils'
import { ChartTable } from './ChartTable'
import './charts.css'

export type DonutSegment = {
  id: string
  label: string
  value: number
  /** A status tone, when the colour means good or bad. */
  tone?: ChartColor
  /** A categorical slot, when it only tells segments apart. */
  color?: ChartColor
  /** Makes the legend entry a link to the filtered view. */
  href?: string
  icon?: ReactNode
}

type Props = {
  segments: DonutSegment[]
  label: string
  /** The headline in the hole, usually the total. */
  center?: { value: ReactNode; label?: string }
  /**
   * The legend carries every value, so it doubles as the accessible data. Turn
   * it off only where the values are shown elsewhere; a hidden table stands in.
   */
  legend?: boolean
  formatValue?: (value: number) => string
  size?: number
}

const radius = 48
const thickness = 14
const box = (radius + thickness) * 2
const circumference = 2 * Math.PI * radius
const gap = 2

/** Part-to-whole for a handful (≤6) of segments, with its legend beside it. */
export function Donut({
  segments,
  label,
  center,
  legend = true,
  formatValue = formatCount,
  size = 132,
}: Props) {
  const entering = useEntrance()
  const [active, setActive] = useState<string | null>(null)
  const clean = segments.map((segment) => ({
    ...segment,
    value: Number.isFinite(segment.value) && segment.value > 0 ? segment.value : 0,
  }))
  const total = clean.reduce((sum, segment) => sum + segment.value, 0)
  const drawn = clean.filter((segment) => segment.value > 0)
  // The surface gap only separates neighbours; a lone segment is a full ring.
  const segmentGap = drawn.length > 1 ? gap : 0

  const starts = runningTotals(drawn.map((segment) => (segment.value / total) * circumference))
  const arcs = drawn.map((segment, index) => ({
    ...segment,
    dash: Math.max(0.001, (segment.value / total) * circumference - segmentGap),
    offset: -starts[index],
  }))

  return (
    <figure className="donut" aria-label={label} data-active={active ?? undefined}>
      <div className="donut-layout">
        <div className="donut-plot" style={{ width: size, height: size }}>
          <svg
            viewBox={`0 0 ${box} ${box}`}
            width={size}
            height={size}
            aria-hidden="true"
            focusable="false"
          >
            <circle
              className="donut-track"
              cx={box / 2}
              cy={box / 2}
              r={radius}
              strokeWidth={thickness}
            />
            {/* The rotation starts the ring at twelve o'clock; it sits on an outer
              group because a CSS animation's transform would replace it. */}
            <g transform={`rotate(-90 ${box / 2} ${box / 2})`}>
              <g className={entering ? 'donut-ring is-entering' : 'donut-ring'}>
                {arcs.map((arc) => (
                  <circle
                    key={arc.id}
                    className={arc.id === active ? 'donut-segment is-active' : 'donut-segment'}
                    cx={box / 2}
                    cy={box / 2}
                    r={radius}
                    strokeWidth={thickness}
                    stroke={colorVar(arc.color ?? arc.tone)}
                    strokeDasharray={`${arc.dash} ${circumference - arc.dash}`}
                    strokeDashoffset={arc.offset}
                    onPointerEnter={() => setActive(arc.id)}
                    onPointerLeave={() => setActive(null)}
                  >
                    <title>{`${arc.label}: ${formatValue(arc.value)}`}</title>
                  </circle>
                ))}
              </g>
            </g>
          </svg>
          {center && (
            <div className="donut-center" aria-hidden="true">
              <strong>{center.value}</strong>
              {center.label && <span>{center.label}</span>}
            </div>
          )}
        </div>
        {legend ? (
          <ul className="chart-legend chart-legend--stacked">
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
                  <span className="chart-legend-share">
                    {formatPercent(percentOf(segment.value, total))}
                  </span>
                </>
              )
              const highlight = {
                onPointerEnter: () => setActive(segment.id),
                onPointerLeave: () => setActive(null),
                onFocus: () => setActive(segment.id),
                onBlur: () => setActive(null),
              }
              return (
                <li key={segment.id} className={segment.id === active ? 'is-active' : undefined}>
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
      </div>
    </figure>
  )
}
