import type { KubeEvent } from '../../api/argo'

export type EventFilters = {
  warningsOnly: boolean
  /** Empty for every kind. */
  kind: string
  search: string
}

export type EventGroup = {
  key: string
  object: KubeEvent['object']
  events: KubeEvent[]
  warnings: number
  lastSeen: string | null
}

export function isWarning(event: KubeEvent) {
  return event.type.toLowerCase() === 'warning'
}

export function eventKinds(events: KubeEvent[]) {
  return [...new Set(events.map((event) => event.object.kind).filter(Boolean))].sort()
}

export function filterEvents(events: KubeEvent[], filters: EventFilters) {
  const needle = filters.search.trim().toLowerCase()
  return events.filter(
    (event) =>
      (!filters.warningsOnly || isWarning(event)) &&
      (!filters.kind || event.object.kind === filters.kind) &&
      (!needle ||
        [event.reason, event.message, event.object.name, event.object.kind, event.source ?? '']
          .join(' ')
          .toLowerCase()
          .includes(needle)),
  )
}

/**
 * Events grouped by the object they are about. Objects with warnings come
 * first — that is where someone opening this tab is usually looking — then
 * the most recently active. Events keep the API's newest-first order.
 */
export function groupEvents(events: KubeEvent[]): EventGroup[] {
  const groups = new Map<string, EventGroup>()
  for (const event of events) {
    const { object } = event
    const key = object.uid || `${object.kind}/${object.namespace ?? ''}/${object.name}`
    const group = groups.get(key) ?? { key, object, events: [], warnings: 0, lastSeen: null }
    group.events.push(event)
    if (isWarning(event)) group.warnings += event.count || 1
    if (event.lastSeen && (!group.lastSeen || event.lastSeen > group.lastSeen)) {
      group.lastSeen = event.lastSeen
    }
    groups.set(key, group)
  }
  return [...groups.values()].sort(
    (left, right) =>
      Number(right.warnings > 0) - Number(left.warnings > 0) ||
      (right.lastSeen ?? '').localeCompare(left.lastSeen ?? ''),
  )
}
