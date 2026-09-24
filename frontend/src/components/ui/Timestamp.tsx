import { useNow } from '../../hooks/useNow'
import { relativeTime } from '../../lib/format'

type Props = {
  value: string | null | undefined
  /** Shown when there is no value. */
  fallback?: string
  className?: string
}

const absolute = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' })

/**
 * "12m ago", with the exact time on hover and in `dateTime` for anything that
 * reads the markup. It ticks on the shared clock.
 */
export function Timestamp({ value, fallback = 'Never', className }: Props) {
  const now = useNow()
  if (!value) return <span className={className}>{fallback}</span>
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return <span className={className}>{fallback}</span>
  return (
    <time className={className} dateTime={value} title={absolute.format(at)}>
      {/* The shared clock ticks every 15s, so it can trail a value that just
          arrived; clamping keeps that reading "just now", not "scheduled". */}
      {relativeTime(value, Math.max(now, at.getTime()))}
    </time>
  )
}
