import { useId, useMemo, useState } from 'react'
import type { ResourceNode } from '../../api/onboarding'
import {
  cardHeight,
  cardWidth,
  countBy,
  edgePath,
  emptyResourceFilters,
  filterResources,
  hasActiveFilters,
  layoutResourceGraph,
  matchesResourceSearch,
  ownerFirstOrder,
  resourceCategory,
  resourceHealthLabel,
  resourceStatusMessage,
  resourceSyncLabel,
  type PositionedNode,
  type ResourceFilters,
} from '../../lib/resource-graph'
import { age } from '../../lib/format'
import { healthTone, statusMeta } from '../../lib/status'
import { KubernetesResourceIcon } from '../../components/KubernetesResourceIcon'
import { FilterIcon } from '../../components/icons'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { Menu, MenuItem } from '../../components/ui/Menu'
import { StatusDot } from '../../components/ui/StatusDot'
import { GraphFilterBar } from './GraphFilterBar'
import { useHealthFlash } from './useHealthFlash'
import { maxZoom, minZoom, usePanZoom, zoomStep } from './usePanZoom'
import './resource-graph.css'

type Props = {
  nodes: ResourceNode[]
  selectedUid?: string
  onSelect: (node: ResourceNode) => void
  onDelete: (node: ResourceNode) => void
  onLogs: (node: ResourceNode) => void
  label: string
  /** A sync is running: edges carry a flowing dash until it finishes. */
  operationRunning?: boolean
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
  const meta = statusMeta('sync', status)
  return (
    <span
      className="graph-sync-mark"
      data-tone={meta.tone}
      title={`Sync: ${meta.label}`}
      aria-label={`Sync: ${meta.label}`}
      role="img"
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M13 8a5 5 0 1 1-1.6-3.7M13 2v3h-3" />
      </svg>
    </span>
  )
}

function CardContent({ node }: { node: PositionedNode }) {
  const health = node.healthStatus && node.healthStatus !== 'Unknown' ? node.healthStatus : ''
  const message = node.virtual ? '' : resourceStatusMessage(node)
  const ports = node.info?.find((item) => item.name === 'Ports')?.value
  return (
    <>
      <span className="graph-card-mark" aria-hidden="true">
        {node.virtual ? (
          <CloudLoadBalancerMark />
        ) : (
          <KubernetesResourceIcon kind={node.kind} className="graph-resource-logo" />
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
        {message && (
          <span className="graph-card-message" title={message}>
            {message}
          </span>
        )}
      </span>
      <span className="graph-card-state">
        {health && (
          <StatusDot
            className="graph-health-dot"
            domain="health"
            status={health}
            size="sm"
            label={`Health: ${statusMeta('health', health).label}`}
          />
        )}
        {!node.virtual && node.syncStatus && <SyncMark status={node.syncStatus} />}
      </span>
    </>
  )
}

/**
 * A Kubernetes topology showing real owner references plus a concise
 * load-balancer-to-Service-to-workload traffic path, drawn the way Argo CD
 * draws it: wide cards in left-to-right tiers, joined by neutral elbows.
 * Cards remain ordinary buttons so the canvas is keyboard navigable and not a
 * black box to assistive technology.
 */
export function ResourceGraph({
  nodes,
  selectedUid,
  onSelect,
  onDelete,
  onLogs,
  label,
  operationRunning = false,
}: Props) {
  const [filters, setFilters] = useState<ResourceFilters>(emptyResourceFilters)
  const markerPrefix = useId().replace(/:/g, '')
  const descriptionId = `${markerPrefix}-controls`
  const changed = useHealthFlash(nodes)

  const shown = filterResources(nodes, filters)
  const layout = layoutResourceGraph(shown)
  const ordered = ownerFirstOrder(layout.nodes)
  const searching = filters.search.trim() !== ''
  const matches = new Set(
    layout.nodes.filter((node) => matchesResourceSearch(node, filters.search)).map((n) => n.uid),
  )
  const matchCount = layout.nodes.filter((node) => !node.virtual && matches.has(node.uid)).length
  const filtering = hasActiveFilters(filters)
  const healthyCount = nodes.filter((node) => healthTone(node.healthStatus) === 'ok').length

  const kindCounts = useMemo(() => countBy(nodes, (node) => node.kind), [nodes])
  const healthCounts = useMemo(() => countBy(nodes, resourceHealthLabel), [nodes])
  const syncCounts = useMemo(() => countBy(nodes, resourceSyncLabel), [nodes])

  // The search only dims, so it must not refit and throw the reader's place away.
  const fitKey = JSON.stringify({ ...filters, search: '' })
  const { zoom, panning, scrollRef, sizerRef, zoomBy, resetFit, canvasHandlers } = usePanZoom({
    contentWidth: layout.width,
    contentHeight: layout.height,
    fitKey,
  })

  function clearFilters() {
    setFilters(emptyResourceFilters)
  }

  return (
    <div className={`graph-shell${operationRunning ? ' is-syncing' : ''}`}>
      <div className="graph-toolbar">
        <GraphFilterBar
          filters={filters}
          onChange={setFilters}
          kindCounts={kindCounts}
          healthCounts={healthCounts}
          syncCounts={syncCounts}
        />
        <p className="graph-toolbar-summary">
          <StatusDot tone="ok" size="sm" plain />
          {healthyCount} of {nodes.length} healthy
        </p>
      </div>

      {(filtering || searching) && (
        <div className="graph-filter-summary" aria-live="polite">
          <span>
            Showing {shown.length} of {nodes.length} resources
            {searching && (
              <>
                {' · '}
                {matchCount} {matchCount === 1 ? 'match' : 'matches'}
              </>
            )}
          </span>
          <span aria-hidden="true">·</span>
          <button type="button" className="link-button" onClick={clearFilters}>
            Clear filters
          </button>
        </div>
      )}

      {shown.length === 0 ? (
        <EmptyState
          compact
          icon={<FilterIcon />}
          title="No resources match these filters"
          description="Every resource on this target is hidden by the current kind, health, or sync filters."
          action={
            <Button size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <div className="graph-viewport">
          <p className="sr-only" id={descriptionId}>
            Drag the background to pan. Press plus or minus to zoom and zero to fit the graph. Hold
            Control or Command and scroll to zoom with the pointer.
          </p>
          <div
            className={`graph-scroll${panning ? ' is-panning' : ''}`}
            ref={scrollRef}
            role="group"
            aria-label="Resource graph canvas"
            aria-describedby={descriptionId}
            tabIndex={0}
            {...canvasHandlers}
          >
            {/* The transform does not affect layout size, so the scroll area is
                sized separately or zooming in would clip instead of scroll. */}
            <div
              className="graph-sizer"
              ref={sizerRef}
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
                <div className="graph-lanes" aria-hidden="true">
                  {layout.lanes.map((lane) => (
                    <div
                      className="graph-lane"
                      key={lane.id}
                      style={{ left: lane.x, width: cardWidth, height: layout.height }}
                    >
                      <span className="graph-lane-label">{lane.label}</span>
                    </div>
                  ))}
                </div>
                <svg
                  className={`graph-edges${operationRunning ? ' is-flowing' : ''}`}
                  width={layout.width}
                  height={layout.height}
                  aria-hidden="true"
                  focusable="false"
                >
                  <defs>
                    {(['owns', 'routes'] as const).map((relation) => (
                      <marker
                        key={relation}
                        id={`${markerPrefix}-${relation}`}
                        viewBox="0 0 8 8"
                        refX="7"
                        refY="4"
                        markerWidth="5"
                        markerHeight="5"
                        orient="auto"
                      >
                        <path d="M 0 0 L 8 4 L 0 8 z" className={`graph-arrow--${relation}`} />
                      </marker>
                    ))}
                  </defs>
                  {layout.edges.map((edge) => {
                    const dimmed = searching && !matches.has(edge.from) && !matches.has(edge.to)
                    return (
                      <path
                        key={edge.id}
                        className={`graph-edge graph-edge--${edge.relation}${dimmed ? ' is-dimmed' : ''}`}
                        d={edgePath(edge)}
                        markerEnd={`url(#${markerPrefix}-${edge.relation})`}
                      />
                    )
                  })}
                </svg>

                <ul className="graph-nodes" aria-label={label}>
                  {ordered.map((node) => {
                    const tone = healthTone(node.healthStatus)
                    const progressing = statusMeta('health', node.healthStatus).inFlight
                    const className = [
                      'graph-card',
                      `graph-card--category-${resourceCategory(node.kind)}`,
                      node.virtual && 'graph-card--virtual',
                      selectedUid === node.uid && 'is-selected',
                      searching && !matches.has(node.uid) && 'is-dimmed',
                    ]
                      .filter(Boolean)
                      .join(' ')
                    const cardProps = {
                      className,
                      'data-tone': tone,
                      'data-changed': changed.has(node.uid) || undefined,
                      'data-progressing': progressing || undefined,
                    }
                    const sweep = progressing && (
                      <span className="graph-card-sweep" aria-hidden="true" />
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
                            {...cardProps}
                            aria-label={`External load balancer ${node.name}`}
                          >
                            {sweep}
                            <div className="graph-card-primary">
                              <CardContent node={node} />
                            </div>
                          </article>
                        ) : (
                          <article {...cardProps}>
                            {sweep}
                            <Menu
                              trigger={
                                <button
                                  type="button"
                                  className="graph-card-primary"
                                  aria-label={`Actions for ${node.kind} ${node.name}`}
                                >
                                  <CardContent node={node} />
                                </button>
                              }
                            >
                              <MenuItem onSelect={() => onSelect(node)}>Info</MenuItem>
                              {node.kind.toLowerCase() === 'pod' && (
                                <MenuItem onSelect={() => onLogs(node)}>Logs</MenuItem>
                              )}
                              <MenuItem danger onSelect={() => onDelete(node)}>
                                Delete
                              </MenuItem>
                            </Menu>
                          </article>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </div>
            </div>
          </div>

          {/* Floating over the canvas rather than in the toolbar, so the controls
              stay reachable however far the graph has been panned. */}
          <div className="graph-controls">
            <div className="graph-legend" role="group" aria-label="Relationship legend">
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
                title="Zoom out (−)"
                disabled={zoom <= minZoom}
                onClick={() => zoomBy(-zoomStep)}
              >
                −
              </button>
              <span className="graph-zoom-value" title="Zoom level">
                {Math.round(zoom * 100)}%
              </span>
              <button
                type="button"
                aria-label="Zoom in"
                title="Zoom in (+)"
                disabled={zoom >= maxZoom}
                onClick={() => zoomBy(zoomStep)}
              >
                +
              </button>
              <button
                type="button"
                className="graph-zoom-fit"
                title="Fit the graph (0)"
                onClick={resetFit}
              >
                Fit
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
