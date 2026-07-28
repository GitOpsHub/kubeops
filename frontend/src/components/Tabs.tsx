import { useId, useRef, type ReactNode } from 'react'

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

  function focusTab(id: string) {
    onChange(id)
    tabRefs.current[id]?.focus()
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
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

  return (
    <>
      <div className="tablist" role="tablist" aria-label={label} onKeyDown={handleKeyDown}>
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
      <div
        className="tabpanel"
        role="tabpanel"
        id={`${baseId}-panel-${active.id}`}
        aria-labelledby={`${baseId}-tab-${active.id}`}
        tabIndex={0}
      >
        {active.content}
      </div>
    </>
  )
}
