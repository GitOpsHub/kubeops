import type { ReactNode } from 'react'
import './Kbd.css'

/** A key or chord as printed on the keyboard, e.g. <Kbd>⌘</Kbd><Kbd>K</Kbd>. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>
}
