import type { ReactNode } from 'react'
import './ToggleGroup.css'

export type ToggleOption<T extends string> = {
  value: T
  label: ReactNode
  icon?: ReactNode
  /** Accessible name when the label alone is not enough, e.g. with a count. */
  ariaLabel?: string
  title?: string
  disabled?: boolean
}

type Props<T extends string> = {
  /** Names the group for assistive technology. */
  label: string
  options: ToggleOption<T>[]
  value: T
  onChange: (value: T) => void
  /** `segmented` is a joined control; `pills` spaces the options apart. */
  appearance?: 'segmented' | 'pills'
  size?: 'sm' | 'md'
  className?: string
  /** Extra class on every option, for callers with their own look. */
  itemClassName?: string
}

/**
 * A row of toggle buttons where exactly one is on. Buttons with
 * `aria-pressed` rather than radios: every option is reachable with Tab and
 * activation is immediate, which matches how the views it switches behave.
 * `aria-pressed` is derived from the same `value` that draws the active
 * state, so the two can never disagree.
 */
export function ToggleGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  appearance = 'segmented',
  size = 'md',
  className = '',
  itemClassName = '',
}: Props<T>) {
  return (
    <div
      className={`toggle-group toggle-group--${appearance} toggle-group--${size} ${className}`.trim()}
      role="group"
      aria-label={label}
    >
      {options.map((option) => {
        const pressed = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            className={`toggle-group-item ${itemClassName}${pressed ? ' is-active' : ''}`.replace(
              /\s+/g,
              ' ',
            )}
            aria-pressed={pressed}
            aria-label={option.ariaLabel}
            title={option.title}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
          >
            {option.icon}
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
