import type { EventFilter } from '../../api/argo'

export const detailTabs = [
  'resources',
  'sync',
  'logs',
  'events',
  'history',
  'chart',
  'timeline',
] as const
export type DetailTab = (typeof detailTabs)[number]

export function isDetailTab(value: string | null): value is DetailTab {
  return detailTabs.includes(value as DetailTab)
}

/**
 * A link into one tab of an application's detail page, optionally on a given
 * target. Everything is in the query string so the link survives a reload
 * and can be pasted into an incident channel.
 */
export function applicationTabHref(
  onboardingId: string,
  tab: DetailTab,
  { target, events }: { target?: string; events?: EventFilter } = {},
) {
  const params = new URLSearchParams()
  if (tab !== 'resources') params.set('tab', tab)
  if (target) params.set('target', target)
  for (const key of ['uid', 'kind', 'name', 'namespace'] as const) {
    if (events?.[key]) params.set(key, events[key] as string)
  }
  const query = params.toString()
  return `/applications/${encodeURIComponent(onboardingId)}${query ? `?${query}` : ''}`
}

/** The Events tab narrowed to one resource, e.g. from its Info panel. */
export function resourceEventsHref(
  onboardingId: string,
  targetId: string,
  resource: { uid?: string; kind: string; name: string; namespace?: string },
) {
  return applicationTabHref(onboardingId, 'events', {
    target: targetId,
    events: {
      uid: resource.uid,
      kind: resource.kind,
      name: resource.name,
      namespace: resource.namespace,
    },
  })
}
