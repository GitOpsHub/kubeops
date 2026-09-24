import type { ReactNode } from 'react'

export type KeyValueItem = {
  label: ReactNode
  value: ReactNode
  /** Identifiers read better in the monospace face. */
  mono?: boolean
  /** Stable key when the label is not a string. */
  key?: string
}

type Props = {
  items: KeyValueItem[]
  /** `grid` flows into columns; `stacked` is one label/value pair per row. */
  layout?: 'grid' | 'stacked'
  className?: string
}

/** Label-over-value facts, for drawers and detail tabs. Empty values read as "—". */
export function KeyValueList({ items, layout = 'grid', className = '' }: Props) {
  return (
    <dl className={`fact-grid fact-grid--${layout} ${className}`.trim()}>
      {items.map((item, index) => (
        <div key={item.key ?? (typeof item.label === 'string' ? item.label : index)}>
          <dt>{item.label}</dt>
          <dd className={item.mono ? 'mono' : undefined}>
            {item.value === '' || item.value === null || item.value === undefined
              ? '—'
              : item.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}
