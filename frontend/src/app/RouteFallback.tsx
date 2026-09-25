import { Skeleton, SkeletonRows } from '../components/ui/Skeleton'

/**
 * Shown while a lazily loaded page's code arrives, shaped like a page header
 * over a table so the layout barely moves when the page lands. No live-region
 * role (hence not `LoadingState`): the page announces its own loading state
 * once it mounts, and two competing status regions would talk over each other.
 */
export function RouteFallback() {
  return (
    <div className="page route-fallback" aria-busy="true">
      <span className="sr-only">Loading page…</span>
      <div className="route-fallback-header" aria-hidden="true">
        <Skeleton width={220} height={28} />
        <Skeleton width={360} height={14} />
      </div>
      <div className="route-fallback-panel" aria-hidden="true">
        <span className="route-fallback-label">
          <span className="spinner" />
          Loading page…
        </span>
        <SkeletonRows rows={5} />
      </div>
    </div>
  )
}
