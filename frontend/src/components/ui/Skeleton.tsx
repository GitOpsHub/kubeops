import type { CSSProperties } from 'react'
import './Skeleton.css'

/**
 * Placeholders shaped like the content that is about to arrive, so the layout
 * does not jump when it does. They are decorative: whoever renders them owns
 * the accessible loading announcement.
 */

type Props = {
  width?: CSSProperties['width']
  height?: CSSProperties['height']
  radius?: CSSProperties['borderRadius']
  className?: string
}

export function Skeleton({ width = '100%', height = 12, radius, className = '' }: Props) {
  return (
    <span
      className={`skeleton ${className}`.trim()}
      style={{ width, height, borderRadius: radius }}
      aria-hidden="true"
    />
  )
}

export function SkeletonRows({ rows = 6, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div className="skeleton-rows" aria-hidden="true">
      {Array.from({ length: rows }, (_, row) => (
        <div
          className="skeleton-row"
          key={row}
          style={{ gridTemplateColumns: `2fr repeat(${columns - 1}, 1fr)` }}
        >
          {Array.from({ length: columns }, (_, column) => (
            <Skeleton key={column} width={column === 0 ? '70%' : '55%'} />
          ))}
        </div>
      ))}
    </div>
  )
}

export function SkeletonCards({ count = 6, height = 168 }: { count?: number; height?: number }) {
  return (
    <div className="skeleton-cards" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <Skeleton key={index} height={height} radius="var(--radius-lg)" />
      ))}
    </div>
  )
}
