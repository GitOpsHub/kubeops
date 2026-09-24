/**
 * The one menu primitive, built the same way as `ui/Dialog`: Radix supplies the
 * behaviour — focus management, roving tabindex, typeahead, Escape, outside
 * click, `aria-expanded` on the trigger — and Menu.css supplies the look.
 */

import * as RadixMenu from '@radix-ui/react-dropdown-menu'
import type { ReactNode } from 'react'
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
