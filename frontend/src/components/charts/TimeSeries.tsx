import { useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { ChartTable } from './ChartTable'
import { colorVar, formatCount, useElementWidth, useEntrance, type ChartColor } from './chart-utils'
import { bandScale, isFiniteNumber, linearScale, niceTicks, tickIndexes } from './scale'
import './charts.css'

export type TimeSeriesPoint = { x: Date | string; y: number | null }

export type TimeSeriesSeries = {
  id: string
  label: string
  /** Bars stack on one another; lines and areas share the same y-axis. */
  kind: 'bar' | 'line' | 'area'
  points: TimeSeriesPoint[]
  tone: ChartColor
}

type Props = {
  series: TimeSeriesSeries[]
  /** Plot height in pixels, x-axis labels included. */
  height: number
  label: string
  yFormat?: (value: number) => string
  xFormat?: (x: Date) => string
  /** Shown in place of the plot when no series has a value. */
  emptyLabel?: string
}

const margin = { top: 8, right: 8, bottom: 24 }
const maxBarWidth = 24
const cornerRadius = 4
const surfaceGap = 2

const dayFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
})

/** Plain dates ("2026-09-24") are UTC days; anything else parses as an instant. */
function toDate(key: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(key) ? new Date(`${key}T00:00:00Z`) : new Date(key)
}

function toKey(x: Date | string) {
  return x instanceof Date ? x.toISOString() : x
}

/**
 * Values over time on one y-axis: bar series stack, line and area series draw
 * over them. Two measures of different scale belong in two charts, never on a
 * second axis. A crosshair and tooltip follow the pointer or the arrow keys;
 * the hidden table carries every value for screen readers.
 */
export function TimeSeries({
  series,
  height,
  label,
  yFormat = formatCount,
  xFormat = (x) => dayFormat.format(x),
  emptyLabel = 'No data for this period',
}: Props) {
  const [frameRef, width] = useElementWidth<HTMLDivElement>(640)
  const entering = useEntrance()
  const clipId = useId()
  const [active, setActive] = useState<number | null>(null)
  const hitRefs = useRef<(SVGRectElement | null)[]>([])

  const keys: string[] = []
  const seen = new Set<string>()
  const lookup = new Map<string, Map<string, number | null>>()
  for (const entry of series) {
    const values = new Map<string, number | null>()
    for (const point of entry.points) {
      const key = toKey(point.x)
      if (!seen.has(key)) {
        seen.add(key)
        keys.push(key)
      }
      values.set(key, isFiniteNumber(point.y) ? point.y : null)
    }
    lookup.set(entry.id, values)
  }
  const value = (seriesId: string, key: string) => lookup.get(seriesId)?.get(key) ?? null

  const bars = series.filter((entry) => entry.kind === 'bar')
  const overlays = series.filter((entry) => entry.kind !== 'bar')
  const stackTotals = keys.map((key) =>
    bars.reduce((sum, entry) => sum + Math.max(0, value(entry.id, key) ?? 0), 0),
  )
  const overlayValues = overlays.flatMap((entry) =>
    keys.map((key) => value(entry.id, key)).filter(isFiniteNumber),
  )
  const hasData =
    keys.length > 0 &&
    (overlayValues.length > 0 ||
      bars.some((entry) => keys.some((key) => value(entry.id, key) !== null)))

  const labels = keys.map((key) => xFormat(toDate(key)))
  const table = (
    <ChartTable
      caption={label}
      headers={['Date', ...series.map((entry) => entry.label)]}
      rows={keys.map((key, index) => [
        labels[index],
        ...series.map((entry) => {
          const reading = value(entry.id, key)
          return reading === null ? '—' : yFormat(reading)
        }),
      ])}
    />
  )

  const legend = series.length > 1 && (
    <ul className="chart-legend chart-legend--compact" aria-hidden="true">
      {series.map((entry) => (
        <li key={entry.id}>
          <span className="chart-legend-item">
            <span
              className={entry.kind === 'line' ? 'chart-key chart-key--line' : 'chart-swatch'}
              style={{ background: colorVar(entry.tone) }}
            />
            <span className="chart-legend-label">{entry.label}</span>
          </span>
        </li>
      ))}
    </ul>
  )

  if (!hasData) {
    return (
      <figure className="time-series" aria-label={label}>
        {legend}
        <div className="time-series-empty" style={{ height }}>
          {emptyLabel}
        </div>
      </figure>
    )
  }

  const low = Math.min(0, ...overlayValues)
  const high = Math.max(0, ...overlayValues, ...stackTotals)
  const integer = [...overlayValues, ...stackTotals].every(Number.isInteger)
  const axis = niceTicks(low, high, height < 140 ? 2 : 4, { integer })
  const tickLabels = axis.ticks.map((tick) => yFormat(tick))
  const left = Math.ceil(10 + Math.max(...tickLabels.map((text) => text.length)) * 6.5)
  const plotBottom = height - margin.bottom
  const y = linearScale([axis.min, axis.max], [plotBottom, margin.top])
  const x = bandScale(keys, [left, Math.max(left + 1, width - margin.right)], {
    paddingInner: 0.35,
    paddingOuter: 0.15,
  })
  const barWidth = Math.min(maxBarWidth, x.bandwidth)
  const center = (index: number) => x(keys[index]) + x.bandwidth / 2
  const baseline = y(Math.max(axis.min, 0))

  const stacks = keys.map((key, index) => {
    let floor = 0
    const drawn = bars
      .map((entry) => ({ entry, reading: Math.max(0, value(entry.id, key) ?? 0) }))
      .filter(({ reading }) => reading > 0)
    return drawn
      .map(({ entry, reading }, level) => {
        const bottom = y(floor) - (level > 0 ? surfaceGap : 0)
        floor += reading
        const top = y(floor)
        return {
          id: entry.id,
          tone: entry.tone,
          path: barPath(
            center(index) - barWidth / 2,
            top,
            barWidth,
            bottom - top,
            level === drawn.length - 1,
          ),
        }
      })
      .filter((segment) => segment.path)
  })

  const paths = overlays.map((entry) => {
    const runs: [number, number][][] = []
    let run: [number, number][] = []
    keys.forEach((key, index) => {
      const reading = value(entry.id, key)
      if (reading === null) {
        if (run.length) runs.push(run)
        run = []
      } else {
        run.push([center(index), y(reading)])
      }
    })
    if (run.length) runs.push(run)
    const line = runs
      .map((points) =>
        points.length === 1
          ? // A lone reading between gaps still needs a visible mark.
            `M${points[0][0] - 3} ${points[0][1]}h6`
          : points.map(([px, py], at) => `${at ? 'L' : 'M'}${px} ${py}`).join(''),
      )
      .join('')
    const area =
      entry.kind === 'area'
        ? runs
            .filter((points) => points.length > 1)
            .map(
              (points) =>
                `M${points[0][0]} ${baseline}` +
                points.map(([px, py]) => `L${px} ${py}`).join('') +
                `L${points[points.length - 1][0]} ${baseline}Z`,
            )
            .join('')
        : ''
    return { entry, line, area }
  })

  const moveFocus = (event: KeyboardEvent, index: number) => {
    const next =
      event.key === 'ArrowRight'
        ? index + 1
        : event.key === 'ArrowLeft'
          ? index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? keys.length - 1
              : null
    if (next === null) return
    event.preventDefault()
    const clamped = Math.max(0, Math.min(keys.length - 1, next))
    hitRefs.current[clamped]?.focus()
  }

  const describePoint = (index: number) =>
    `${labels[index]}: ${series
      .map((entry) => {
        const reading = value(entry.id, keys[index])
        return `${entry.label} ${reading === null ? 'no data' : yFormat(reading)}`
      })
      .join(', ')}`

  // The first point is the tab stop until the reader moves; arrows rove from there.
  const tabStop = active ?? 0
  const tooltipLeft = active === null ? 0 : Math.max(72, Math.min(width - 72, center(active)))

  return (
    <figure className="time-series" aria-label={label}>
      {legend}
      <div className="time-series-frame" ref={frameRef}>
        <svg
          className="time-series-svg"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="group"
          aria-label={`${label}, one point per date`}
          onPointerLeave={() => setActive(null)}
        >
          <g aria-hidden="true">
            {axis.ticks.map((tick, index) => (
              <g key={tick}>
                <line
                  className="chart-grid"
                  x1={left}
                  x2={width - margin.right}
                  y1={y(tick)}
                  y2={y(tick)}
                />
                <text
                  className="chart-axis-label"
                  x={left - 6}
                  y={y(tick)}
                  dy="0.32em"
                  textAnchor="end"
                >
                  {tickLabels[index]}
                </text>
              </g>
            ))}
            {tickIndexes(keys.length, width < 480 ? 4 : 7).map((index) => (
              <text
                key={keys[index]}
                className="chart-axis-label"
                x={center(index)}
                y={height - 6}
                textAnchor="middle"
              >
                {labels[index]}
              </text>
            ))}
            {active !== null && (
              <line
                className="chart-crosshair"
                x1={center(active)}
                x2={center(active)}
                y1={margin.top}
                y2={plotBottom}
              />
            )}
            <g className={entering ? 'time-series-bars is-entering' : 'time-series-bars'}>
              {stacks.flatMap((stack, index) =>
                stack.map((segment) => (
                  <path
                    key={`${keys[index]}-${segment.id}`}
                    className={active === index ? 'time-series-bar is-active' : 'time-series-bar'}
                    d={segment.path}
                    fill={colorVar(segment.tone)}
                  />
                )),
              )}
            </g>
            {entering && (
              <clipPath id={clipId}>
                <rect className="chart-reveal" x={0} y={0} width={width} height={height} />
              </clipPath>
            )}
            <g clipPath={entering ? `url(#${clipId})` : undefined}>
              {paths.map(({ entry, line, area }) => (
                <g key={entry.id} style={{ '--series': colorVar(entry.tone) } as CSSProperties}>
                  {area && <path className="time-series-area" d={area} />}
                  <path className="time-series-line" d={line} />
                </g>
              ))}
            </g>
            {active !== null &&
              overlays.map((entry) => {
                const reading = value(entry.id, keys[active])
                return reading === null ? null : (
                  <circle
                    key={entry.id}
                    className="time-series-dot"
                    cx={center(active)}
                    cy={y(reading)}
                    r={4}
                    fill={colorVar(entry.tone)}
                  />
                )
              })}
          </g>
          <g className="time-series-hits">
            {keys.map((key, index) => (
              <rect
                key={key}
                ref={(element) => {
                  hitRefs.current[index] = element
                }}
                x={x(key) - (x.step - x.bandwidth) / 2}
                y={margin.top}
                width={Math.max(1, x.step)}
                height={Math.max(1, plotBottom - margin.top)}
                role="img"
                aria-label={describePoint(index)}
                tabIndex={index === tabStop ? 0 : -1}
                onPointerEnter={() => setActive(index)}
                onFocus={() => setActive(index)}
                onBlur={() => setActive(null)}
                onKeyDown={(event) => moveFocus(event, index)}
              />
            ))}
          </g>
        </svg>
        {active !== null && (
          <div className="chart-tooltip" style={{ left: tooltipLeft }} aria-hidden="true">
            <span className="chart-tooltip-title">{labels[active]}</span>
            {series.map((entry) => {
              const reading = value(entry.id, keys[active])
              return (
                <span key={entry.id} className="chart-tooltip-row">
                  <span
                    className="chart-key chart-key--line"
                    style={{ background: colorVar(entry.tone) }}
                  />
                  <strong>{reading === null ? '—' : yFormat(reading)}</strong>
                  <span>{entry.label}</span>
                </span>
              )
            })}
          </div>
        )}
      </div>
      {table}
    </figure>
  )
}

/** A bar anchored square on its baseline, with a rounded data end when it tops the stack. */
function barPath(left: number, top: number, width: number, height: number, rounded: boolean) {
  if (!(height > 0) || !(width > 0)) return ''
  const r = rounded ? Math.min(cornerRadius, width / 2, height) : 0
  const right = left + width
  const bottom = top + height
  if (r === 0) return `M${left} ${bottom}V${top}H${right}V${bottom}Z`
  return (
    `M${left} ${bottom}V${top + r}` +
    `Q${left} ${top} ${left + r} ${top}` +
    `H${right - r}Q${right} ${top} ${right} ${top + r}` +
    `V${bottom}Z`
  )
}
