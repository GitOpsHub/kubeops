import { Skeleton, SkeletonRows } from '../components/ui/Skeleton'

/**
 * Shown while a lazily loaded page's code arrives. No live-region role: the
 * page announces its own loading state once it mounts, and two competing
 * status regions would talk over each other.
 */
export function RouteFallback() {
  return (
    <div className="route-fallback" aria-busy="true">
      <span className="sr-only">Loading page…</span>
      <Skeleton width={220} height={28} />
      <Skeleton width={360} height={14} />
      <div className="route-fallback-panel">
        <SkeletonRows rows={5} />
      </div>
    </div>
  )
}
