/**
 * The one menu primitive, built the same way as `ui/Dialog`: Radix supplies the
 * behaviour — focus management, roving tabindex, typeahead, Escape, outside
 * click, `aria-expanded` on the trigger — and Menu.css supplies the look.
 */

import * as RadixMenu from '@radix-ui/react-dropdown-menu'
import type { ReactNode } from 'react'
import { CheckIcon } from '../icons'
import './Menu.css'

type MenuProps = {
  /** The button that opens the menu. Rendered through `asChild`. */
  trigger: ReactNode
  className?: string
  align?: 'start' | 'center' | 'end'
  children: ReactNode
}

export function Menu({ trigger, className = '', align = 'end', children }: MenuProps) {
  return (
    <RadixMenu.Root>
      <RadixMenu.Trigger asChild>{trigger}</RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content className={`menu ${className}`.trim()} align={align} sideOffset={6}>
          {children}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  )
}

type MenuItemProps = {
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
  children: ReactNode
}

/**
 * `onSelect` fires after Radix has closed the menu and restored focus, so an
 * item that opens a dialog does not race the menu's own focus handling.
 */
export function MenuItem({ danger = false, disabled, onSelect, children }: MenuItemProps) {
  return (
    <RadixMenu.Item
      className={danger ? 'menu-item menu-item--danger' : 'menu-item'}
      disabled={disabled}
      onSelect={() => onSelect()}
    >
      {children}
    </RadixMenu.Item>
  )
}

type MenuRadioGroupProps<T extends string> = {
  value: T
  onValueChange: (value: T) => void
  /** Names the group, e.g. "Theme", for assistive technology. */
  label: string
  children: ReactNode
}

/** A set of mutually exclusive choices; items announce as `menuitemradio`. */
export function MenuRadioGroup<T extends string>({
  value,
  onValueChange,
  label,
  children,
}: MenuRadioGroupProps<T>) {
  return (
    <RadixMenu.RadioGroup
      value={value}
      onValueChange={(next) => onValueChange(next as T)}
      aria-label={label}
    >
      {children}
    </RadixMenu.RadioGroup>
  )
}

export function MenuRadioItem({
  value,
  icon,
  children,
}: {
  value: string
  icon?: ReactNode
  children: ReactNode
}) {
  return (
    <RadixMenu.RadioItem className="menu-item menu-item--radio" value={value}>
      {icon && <span className="menu-item-icon">{icon}</span>}
      <span className="menu-item-label">{children}</span>
      <RadixMenu.ItemIndicator className="menu-item-indicator">
        <CheckIcon />
      </RadixMenu.ItemIndicator>
    </RadixMenu.RadioItem>
  )
}

/**
 * One of several independent choices; announced as `menuitemcheckbox`. The
 * menu stays open on select, so a multi-select can be ticked in one visit.
 */
export function MenuCheckboxItem({
  checked,
  onCheckedChange,
  icon,
  children,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  icon?: ReactNode
  children: ReactNode
}) {
  return (
    <RadixMenu.CheckboxItem
      className="menu-item menu-item--radio"
      checked={checked}
      onCheckedChange={onCheckedChange}
      onSelect={(event) => event.preventDefault()}
    >
      {icon && <span className="menu-item-icon">{icon}</span>}
      <span className="menu-item-label">{children}</span>
      <RadixMenu.ItemIndicator className="menu-item-indicator">
        <CheckIcon />
      </RadixMenu.ItemIndicator>
    </RadixMenu.CheckboxItem>
  )
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <RadixMenu.Label className="menu-label">{children}</RadixMenu.Label>
}

export function MenuSeparator() {
  return <RadixMenu.Separator className="menu-separator" />
}
