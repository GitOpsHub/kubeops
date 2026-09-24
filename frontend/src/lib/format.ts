/**
 * Time and count formatting shared by every page, so "12m ago" means the same
 * thing in the sidebar, a table cell, and the timeline.
 */

/** Compact age such as "3d" or "12m", from a resource's creation timestamp. */
export function age(createdAt: string, now = Date.now()) {
  if (!createdAt) return '—'
  const created = new Date(createdAt).getTime()
  if (Number.isNaN(created)) return '—'
  const seconds = Math.max(0, Math.round((now - created) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/**
 * Conversational age such as "12m ago". Anything older than a month reads as a
 * date instead, where "43d ago" stops being useful. A missing value is "Never"
 * because every caller uses it for something that may not have happened yet.
 */
export function relativeTime(value: string | null | undefined, now = Date.now()) {
  if (!value) return 'Never'
  const at = new Date(value).getTime()
  if (Number.isNaN(at)) return ''
  const seconds = Math.round((now - at) / 1000)
  if (seconds < -45) return 'scheduled'
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days <= 30) return `${days}d ago`
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** "1 cluster", "3 clusters". */
export function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

/** True when a timestamp is missing or older than `maxAgeMs`. */
export function isOlderThan(value: string | null | undefined, maxAgeMs: number, now = Date.now()) {
  return !value || now - new Date(value).getTime() > maxAgeMs
}
