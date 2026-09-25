import type { CSSProperties, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { colorVar, formatCount, useEntrance, type ChartColor } from './chart-utils'
import './charts.css'

export type BarListItem = {
  id: string
  label: string
  value: number
  href?: string
  icon?: ReactNode
}

type Props = {
  items: BarListItem[]
  /** Accessible name of the list. */
  label: string
  formatValue?: (value: number) => string
  /** One series, one colour: bar length already encodes the value. */
  color?: ChartColor
  /** Scale bars against this instead of the largest item, e.g. a shared total. */
  max?: number
}

/**
 * Ranked horizontal bars with their values printed, for "top N" lists. Every
 * value is text in the list, so no hidden table is needed.
 */
export function BarList({
  items,
  label,
  formatValue = formatCount,
  color = 'chart-1',
  max,
}: Props) {
  const entering = useEntrance()
  const values = items.map((item) =>
    Number.isFinite(item.value) && item.value > 0 ? item.value : 0,
  )
  const ceiling = max && max > 0 ? max : Math.max(0, ...values)

  return (
    <ul
      className={entering ? 'bar-list is-entering' : 'bar-list'}
      aria-label={label}
      style={{ '--series': colorVar(color) } as CSSProperties}
    >
      {items.map((item, index) => {
        const width = ceiling > 0 ? (values[index] / ceiling) * 100 : 0
        const body = (
          <>
            {item.icon && (
              <span className="bar-list-icon" aria-hidden="true">
                {item.icon}
              </span>
            )}
            <span className="bar-list-label">{item.label}</span>
            <span className="bar-list-track" aria-hidden="true">
              <span className="bar-list-fill" style={{ width: `${width}%` }} />
            </span>
            <span className="bar-list-value">{formatValue(values[index])}</span>
          </>
        )
        return (
          <li key={item.id}>
            {item.href ? (
              <Link className="bar-list-row" to={item.href}>
                {body}
              </Link>
            ) : (
              <span className="bar-list-row">{body}</span>
            )}
          </li>
        )
      })}
    </ul>
  )
}
