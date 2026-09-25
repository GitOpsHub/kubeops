import type { ReactNode } from 'react'
import { ChevronDownIcon } from '../icons'
import { Menu, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator } from './Menu'
import './FilterMenu.css'

export type FilterMenuOption = {
  value: string
  label: ReactNode
  icon?: ReactNode
  /** Items sharing a group are listed together under that heading. */
  group?: string
}

type Props = {
  /** What is being filtered, e.g. "Source". Shown on the button and names the choices. */
  label: string
  value: string
  onChange: (value: string) => void
  options: FilterMenuOption[]
  /** The no-filter choice, e.g. "All sources". */
  allLabel: string
  /** Shown on the button for a value missing from `options` (e.g. from a stale link). */
  fallbackLabel?: (value: string) => ReactNode
  align?: 'start' | 'end'
}

// Radix radio items need a non-empty value; this stands in for "no filter".
const allValue = '__all__'

/**
 * A compact "Label: value" button that opens a single-choice menu: a filter
 * that takes a toolbar slot without a full-width select. The button reads as
 * "Source All sources" to assistive technology — its visible words — and
 * Radix gives it `aria-haspopup` and `aria-expanded`.
 */
export function FilterMenu({
  label,
  value,
  onChange,
  options,
  allLabel,
  fallbackLabel,
  align = 'start',
}: Props) {
  const selected = options.find((option) => option.value === value)
  const current = value ? (selected?.label ?? fallbackLabel?.(value) ?? value) : allLabel

  const groups: { name?: string; items: FilterMenuOption[] }[] = []
  for (const option of options) {
    const last = groups[groups.length - 1]
    if (last && last.name === option.group) last.items.push(option)
    else groups.push({ name: option.group, items: [option] })
  }

  return (
    <Menu
      align={align}
      className="filter-menu"
      trigger={
        <button type="button" className={`filter-button${value ? ' is-active' : ''}`}>
          <span className="filter-button-label">{label}</span>{' '}
          <span className="filter-button-value">{current}</span>
          <ChevronDownIcon aria-hidden="true" />
        </button>
      }
    >
      <MenuRadioGroup
        label={label}
        value={value || allValue}
        onValueChange={(next) => onChange(next === allValue ? '' : next)}
      >
        <MenuRadioItem value={allValue}>{allLabel}</MenuRadioItem>
        {groups.map((group, index) => (
          <div key={group.name ?? index} role="none">
            <MenuSeparator />
            {group.name && <MenuLabel>{group.name}</MenuLabel>}
            {group.items.map((option) => (
              <MenuRadioItem key={option.value} value={option.value} icon={option.icon}>
                {option.label}
              </MenuRadioItem>
            ))}
          </div>
        ))}
      </MenuRadioGroup>
    </Menu>
  )
}
