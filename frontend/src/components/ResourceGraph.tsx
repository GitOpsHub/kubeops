import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ResourceNode } from '../api/onboarding'
import {
  cardHeight,
  cardWidth,
  edgePath,
  layoutResourceGraph,
  resourceCategory,
} from '../lib/resource-graph'
import { age } from '../lib/resource-tree'
import { KubernetesResourceIcon } from './KubernetesResourceIcon'

const zoomStep = 0.1
const minZoom = 0.4
const maxZoom = 1.6
/* A graph shrunk far enough to fit is a graph nobody can read. Opening the view
   stops at the point where a resource name is still legible and lets the rest
   scroll; pressing Fit is an explicit request to see everything, so that one
   goes all the way down to `minZoom`. */
const minAutoZoom = 0.7
/** Matches the `.graph-scroll` padding, so "fit" leaves the same gutter. */
const canvasPadding = 24

type Props = {
  nodes: ResourceNode[]
  selectedUid?: string
  onSelect: (node: ResourceNode) => void
  label: string
}

function healthTone(status: string) {
  const normalized = status.toLowerCase()
  if (normalized === 'healthy') return 'healthy'
  if (normalized === 'degraded' || normalized === 'missing') return 'failed'
  if (normalized === 'progressing' || normalized === 'suspended') return 'progressing'
  return 'unknown'
}

function clamp(value: number) {
  return Math.min(maxZoom, Math.max(minZoom, value))
}

function CloudLoadBalancerMark() {
  return (
    <svg className="graph-cloud-logo" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7.5 17.5h9.25a4.25 4.25 0 0 0 .5-8.47A6 6 0 0 0 6 7.25a5.25 5.25 0 0 0 1.5 10.25Z" />
      <path d="M8.5 13h7M10 10.75 7.75 13 10 15.25M14 10.75 16.25 13 14 15.25" />
    </svg>
  )
}

/** Argo CD marks sync state with a circular-arrow glyph beside the health dot. */
function SyncMark({ status }: { status: string }) {
  const normalized = status.toLowerCase().replace(/\s+/g, '')
  return (
    <span
      className={`graph-sync-mark graph-sync-mark--${normalized}`}
      title={`Sync: ${status}`}
      aria-label={`Sync ${status}`}
      role="img"
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M13 8a5 5 0 1 1-1.6-3.7M13 2v3h-3" />
      </svg>
    </span>
  )
}

/**
 * A Kubernetes topology showing real owner references plus a concise
 * load-balancer-to-Service-to-workload traffic path, drawn the way Argo CD
 * draws it: wide pills in left-to-right tiers, joined by neutral elbows.
 * Cards remain ordinary buttons so the canvas is keyboard navigable and not a
 * black box to assistive technology.
 */
export function ResourceGraph({ nodes, selectedUid, onSelect, label }: Props) {
  const [zoom, setZoom] = useState(1)
  // Once the operator picks a zoom, the canvas stops re-fitting itself on every
  // resize — otherwise their choice would be undone by a sidebar opening.
  const [zoomPinned, setZoomPinned] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const markerPrefix = useId().replace(/:/g, '')
  const layout = layoutResourceGraph(nodes)
  const resourceCount = layout.nodes.filter((node) => !node.virtual).length
  const layoutWidth = layout.width

  const fit = useCallback(
    (floor = minZoom) => {
      const viewport = scrollRef.current
      if (!viewport || layoutWidth === 0) return
      const available = viewport.clientWidth - canvasPadding * 2
      // Never magnifies: a two-node graph blown up to fill the panel looks broken.
      setZoom(Math.max(floor, clamp(Math.min(1, available / layoutWidth))))
    },
    [layoutWidth],
  )

  // The graph is often wider than the panel, so it opens fitted rather than
  // clipped, and follows the panel as it resizes until the operator zooms.
  useLayoutEffect(() => {
    if (!zoomPinned) fit(minAutoZoom)
  }, [fit, zoomPinned])

  useEffect(() => {
    const viewport = scrollRef.current
    // Re-fitting on resize is an enhancement on top of the fit that already
    // ran on mount, so an environment without the observer simply keeps it.
    if (!viewport || zoomPinned || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => fit(minAutoZoom))
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [fit, zoomPinned])

  function adjustZoom(delta: number) {
    setZoomPinned(true)
    setZoom((current) => clamp(current + delta))
  }

  return (
    <div className="graph-shell">
      <div className="graph-toolbar">
        <strong>Kubernetes topology</strong>
        <span className="quiet-note">
          {resourceCount} {resourceCount === 1 ? 'resource' : 'resources'}
        </span>
      </div>

      <div className="graph-viewport">
        <div className="graph-scroll" ref={scrollRef}>
          {/* The transform does not affect layout size, so the scroll area is
              sized separately or zooming in would clip instead of scroll. */}
          <div
            className="graph-sizer"
            style={{ width: layout.width * zoom, height: layout.height * zoom }}
          >
            <div
              className="graph-canvas"
              style={{
                width: layout.width,
                height: layout.height,
                transform: `scale(${zoom})`,
              }}
            >
              <svg
                className="graph-edges"
                width={layout.width}
                height={layout.height}
                aria-hidden="true"
                focusable="false"
              >
                <defs>
                  <marker
                    id={`${markerPrefix}-owns`}
                    viewBox="0 0 8 8"
                    refX="7"
                    refY="4"
                    markerWidth="5"
                    markerHeight="5"
                    orient="auto"
                  >
                    <path d="M 0 0 L 8 4 L 0 8 z" className="graph-arrow--owns" />
                  </marker>
                  <marker
                    id={`${markerPrefix}-routes`}
                    viewBox="0 0 8 8"
                    refX="7"
                    refY="4"
                    markerWidth="5"
                    markerHeight="5"
                    orient="auto"
                  >
                    <path d="M 0 0 L 8 4 L 0 8 z" className="graph-arrow--routes" />
                  </marker>
                </defs>
                {layout.edges.map((edge) => (
                  <path
                    key={edge.id}
                    className={`graph-edge graph-edge--${edge.relation}`}
                    d={edgePath(edge)}
                    markerEnd={`url(#${markerPrefix}-${edge.relation})`}
                  />
                ))}
              </svg>

              <ul className="graph-nodes" aria-label={label}>
                {layout.nodes.map((node) => {
                  const className =
                    `graph-card graph-card--${healthTone(node.healthStatus)} ` +
                    `graph-card--category-${resourceCategory(node.kind)} ` +
                    `${node.virtual ? 'graph-card--virtual' : ''} ` +
                    `${selectedUid === node.uid ? 'is-selected' : ''}`
                  const ports = node.info?.find((item) => item.name === 'Ports')?.value
                  const content = (
                    <>
                      <span className="graph-card-mark" aria-hidden="true">
                        {node.virtual ? (
                          <CloudLoadBalancerMark />
                        ) : (
                          <KubernetesResourceIcon
                            kind={node.kind}
                            className="graph-resource-logo"
                          />
                        )}
                      </span>
                      <span className="graph-card-copy">
                        <span className="graph-card-kind">
                          {node.kind}
                          <i aria-hidden="true">·</i>
                          <span className="graph-card-age">
                            {node.virtual ? ports || 'External' : age(node.createdAt)}
                          </span>
                        </span>
                        <span className="graph-card-name" title={node.name}>
                          {node.name}
                        </span>
                      </span>
                      <span className="graph-card-state">
                        {node.healthStatus && node.healthStatus !== 'Unknown' && (
                          <span
                            className={`graph-health-dot graph-health-dot--${healthTone(
                              node.healthStatus,
                            )}`}
                            title={`Health: ${node.healthStatus}`}
                            aria-label={node.healthStatus}
                            role="img"
                          />
                        )}
                        {!node.virtual && node.syncStatus && (
                          <SyncMark status={node.syncStatus} />
                        )}
                      </span>
                    </>
                  )

                  return (
                    <li
                      key={node.uid}
                      className="graph-node"
                      style={{
                        left: node.x,
                        top: node.y,
                        width: cardWidth,
                        height: cardHeight,
                      }}
                    >
                      {node.virtual ? (
                        <article
                          className={className}
                          aria-label={`External load balancer ${node.name}`}
                        >
                          {content}
                        </article>
                      ) : (
                        <button
                          type="button"
                          className={className}
                          aria-pressed={selectedUid === node.uid}
                          onClick={() => onSelect(node)}
                        >
                          {content}
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          </div>
        </div>

        {/* Floating over the canvas rather than in the toolbar, so the controls
            stay reachable however far the graph has been scrolled. */}
        <div className="graph-controls">
          <div className="graph-legend" aria-label="Relationship legend">
            <span>
              <i className="graph-legend-line graph-legend-line--owns" />
              owns
            </span>
            <span>
              <i className="graph-legend-line graph-legend-line--routes" />
              routes
            </span>
          </div>
          <div className="graph-zoom" role="group" aria-label="Zoom">
            <button
              type="button"
              aria-label="Zoom out"
              disabled={zoom <= minZoom}
              onClick={() => adjustZoom(-zoomStep)}
            >
              −
            </button>
            <span className="graph-zoom-value">{Math.round(zoom * 100)}%</span>
            <button
              type="button"
              aria-label="Zoom in"
              disabled={zoom >= maxZoom}
              onClick={() => adjustZoom(zoomStep)}
            >
              +
            </button>
            <button
              type="button"
              className="graph-zoom-fit"
              onClick={() => {
                setZoomPinned(false)
                fit()
              }}
            >
              Fit
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
