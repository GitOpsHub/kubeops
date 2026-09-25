import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import './Tabs.css'

/**
 * Minimal tablist following the WAI-ARIA pattern: arrow keys move between tabs,
 * Home and End jump to the ends, and only the selected tab is in the tab order.
 */

export type TabItem = {
  id: string
  label: string
  content: ReactNode
}

type Props = {
  items: TabItem[]
  activeId: string
  onChange: (id: string) => void
  label: string
}

export function Tabs({ items, activeId, onChange, label }: Props) {
  const baseId = useId()
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const listRef = useRef<HTMLDivElement | null>(null)

  function focusTab(id: string) {
    onChange(id)
    tabRefs.current[id]?.focus()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = items.findIndex((item) => item.id === activeId)
    if (index === -1) return

    switch (event.key) {
      case 'ArrowRight':
        focusTab(items[(index + 1) % items.length].id)
        break
      case 'ArrowLeft':
        focusTab(items[(index - 1 + items.length) % items.length].id)
        break
      case 'Home':
        focusTab(items[0].id)
        break
      case 'End':
        focusTab(items[items.length - 1].id)
        break
      default:
        return
    }
    event.preventDefault()
  }

  const active = items.find((item) => item.id === activeId) ?? items[0]

  // On a phone the tab strip scrolls sideways, and a deep link to a late tab
  // opened with the selected tab out of sight. Only the strip scrolls here,
  // never the page, so this is not scrollIntoView.
  useEffect(() => {
    const list = listRef.current
    const tab = tabRefs.current[active.id]
    if (!list || !tab) return
    const start = tab.offsetLeft - list.offsetLeft
    const end = start + tab.offsetWidth
    if (start < list.scrollLeft) list.scrollLeft = start
    else if (end > list.scrollLeft + list.clientWidth) list.scrollLeft = end - list.clientWidth
  }, [active.id])

  return (
    <>
      <div
        ref={listRef}
        className="tablist"
        role="tablist"
        aria-label={label}
        onKeyDown={handleKeyDown}
      >
        {items.map((item) => {
          const selected = item.id === active.id
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`${baseId}-tab-${item.id}`}
              className="tab"
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${item.id}`}
              tabIndex={selected ? 0 : -1}
              ref={(node) => {
                tabRefs.current[item.id] = node
              }}
              onClick={() => onChange(item.id)}
            >
              {item.label}
            </button>
          )
        })}
      </div>
      {/* Every panel is in the DOM so each tab's aria-controls resolves, but
          only the active one renders its content: the others may poll or
          fetch, and hidden panels should not. */}
      {items.map((item) => {
        const selected = item.id === active.id
        return (
          <div
            key={item.id}
            className="tabpanel"
            role="tabpanel"
            id={`${baseId}-panel-${item.id}`}
            aria-labelledby={`${baseId}-tab-${item.id}`}
            tabIndex={selected ? 0 : -1}
            hidden={!selected}
          >
            {selected && item.content}
          </div>
        )
      })}
    </>
  )
}
