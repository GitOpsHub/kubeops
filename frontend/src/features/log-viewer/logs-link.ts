import type { LogResourceRef } from '../../api/argo'

/** A deep link to the full-page viewer for one resource on one target. */
export function logsPageHref(
  onboardingId: string,
  targetId: string,
  resource?: LogResourceRef,
  container?: string,
) {
  const params = new URLSearchParams({ target: targetId })
  if (resource) {
    params.set('kind', resource.kind)
    params.set('name', resource.name)
    if (resource.namespace) params.set('namespace', resource.namespace)
  }
  if (container) params.set('container', container)
  return `/applications/${encodeURIComponent(onboardingId)}/logs?${params}`
}
