import type { ReactNode } from 'react'
import './SegmentedControl.css'

export type SegmentOption<T extends string> = {
  value: T
  label: ReactNode
  icon?: ReactNode
  /** Accessible name when the label alone is not enough, e.g. with a count. */
  ariaLabel?: string
  title?: string
}

type Props<T extends string> = {
  /** Names the group for assistive technology. */
  label: string
  options: SegmentOption<T>[]
  value: T
  onChange: (value: T) => void
  size?: 'sm' | 'md'
  className?: string
}

/**
 * A row of toggle buttons where exactly one is on. Rendered as buttons with
 * `aria-pressed` rather than radios: every option is reachable with Tab and
 * activation is immediate, which matches how the views it switches behave.
 */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  size = 'md',
  className = '',
}: Props<T>) {
  return (
    <div
      className={`segmented segmented--${size} ${className}`.trim()}
      role="group"
      aria-label={label}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={option.value === value ? 'segmented-option is-active' : 'segmented-option'}
          aria-pressed={option.value === value}
          aria-label={option.ariaLabel}
          title={option.title}
          onClick={() => onChange(option.value)}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  )
}
