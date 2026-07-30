import { useId, useState } from 'react'
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
import { StatusBadge } from './StatusBadge'

const zoomStep = 0.2
const minZoom = 0.6
const maxZoom = 1.4

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

function CloudLoadBalancerMark() {
  return (
    <svg
      className="graph-cloud-logo"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path d="M7.5 17.5h9.25a4.25 4.25 0 0 0 .5-8.47A6 6 0 0 0 6 7.25a5.25 5.25 0 0 0 1.5 10.25Z" />
      <path d="M8.5 13h7M10 10.75 7.75 13 10 15.25M14 10.75 16.25 13 14 15.25" />
    </svg>
  )
}

/**
 * A Kubernetes topology showing real owner references plus a concise
 * load-balancer-to-Service-to-workload traffic path.
 * Cards remain ordinary buttons so the canvas is keyboard navigable and not a
 * black box to assistive technology.
 */
export function ResourceGraph({ nodes, selectedUid, onSelect, label }: Props) {
  const [zoom, setZoom] = useState(1)
  const markerPrefix = useId().replace(/:/g, '')
  const layout = layoutResourceGraph(nodes)
  const resourceCount = layout.nodes.filter((node) => !node.virtual).length

  return (
    <div className="graph-shell">
      <div className="graph-toolbar">
        <div className="graph-toolbar-copy">
          <div className="graph-toolbar-title">
            <strong>Kubernetes topology</strong>
            <span className="quiet-note">
              {resourceCount} {resourceCount === 1 ? 'resource' : 'resources'}
            </span>
          </div>
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
        </div>
        <div className="graph-zoom" role="group" aria-label="Zoom">
          <button
            type="button"
            aria-label="Zoom out"
            disabled={zoom <= minZoom}
            onClick={() => setZoom((current) => Math.max(minZoom, current - zoomStep))}
          >
            −
          </button>
          <button type="button" onClick={() => setZoom(1)}>
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            aria-label="Zoom in"
            disabled={zoom >= maxZoom}
            onClick={() => setZoom((current) => Math.min(maxZoom, current + zoomStep))}
          >
            +
          </button>
        </div>
      </div>

      <div className="graph-scroll">
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
              <span key={lane.id} style={{ left: lane.x, width: cardWidth }}>
                {lane.label}
              </span>
            ))}
          </div>

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
              const content = (
                <>
                  <span className="graph-card-top">
                    <span className="graph-card-kind">
                      <span className="resource-kind-mark" aria-hidden="true">
                        {node.virtual ? (
                          <CloudLoadBalancerMark />
                        ) : (
                          <KubernetesResourceIcon
                            kind={node.kind}
                            className="graph-resource-logo"
                          />
                        )}
                      </span>
                      <span className="resource-kind">{node.kind}</span>
                    </span>
                    <span className="resource-age">
                      {node.virtual ? 'External' : age(node.createdAt)}
                    </span>
                  </span>
                  <span className="graph-card-name" title={node.name}>
                    {node.name}
                  </span>
                  <span className="graph-card-state">
                    {node.healthStatus && node.healthStatus !== 'Unknown' && (
                      <StatusBadge status={node.healthStatus} />
                    )}
                    {node.virtual && node.info?.find((item) => item.name === 'Ports') && (
                      <span className="graph-external-badge">
                        {node.info.find((item) => item.name === 'Ports')?.value}
                      </span>
                    )}
                    {!node.virtual && node.syncStatus && (
                      <span className={`resource-sync resource-sync--${node.syncStatus.toLowerCase()}`}>
                        {node.syncStatus}
                      </span>
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
  )
}
