import { useState } from 'react'
import type { ResourceNode } from '../api/onboarding'
import {
  cardHeight,
  cardWidth,
  edgePath,
  layoutResourceGraph,
} from '../lib/resource-graph'
import { age } from '../lib/resource-tree'
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

/**
 * The resource tree drawn the way Argo CD draws it: columns by ownership depth,
 * joined by connectors.
 *
 * The cards are positioned absolutely but remain ordinary buttons in a
 * depth-first list, so keyboard order still follows the hierarchy and the
 * canvas is not a black box to assistive technology. The connectors are
 * decoration and are hidden from it.
 */
export function ResourceGraph({ nodes, selectedUid, onSelect, label }: Props) {
  const [zoom, setZoom] = useState(1)
  const layout = layoutResourceGraph(nodes)

  return (
    <div className="graph-shell">
      <div className="graph-toolbar">
        <span className="quiet-note">
          {layout.nodes.length} {layout.nodes.length === 1 ? 'resource' : 'resources'}
        </span>
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
          <svg
            className="graph-edges"
            width={layout.width}
            height={layout.height}
            aria-hidden="true"
            focusable="false"
          >
            {layout.edges.map((edge) => (
              <path key={edge.id} d={edgePath(edge)} />
            ))}
          </svg>

          <ul className="graph-nodes" aria-label={label}>
            {layout.nodes.map((node) => (
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
                <button
                  type="button"
                  className={`graph-card ${selectedUid === node.uid ? 'is-selected' : ''}`}
                  aria-pressed={selectedUid === node.uid}
                  onClick={() => onSelect(node)}
                >
                  <span className="graph-card-top">
                    <span className="resource-kind">{node.kind}</span>
                    <span className="resource-age">{age(node.createdAt)}</span>
                  </span>
                  <span className="graph-card-name" title={node.name}>
                    {node.name}
                  </span>
                  <span className="graph-card-state">
                    {node.healthStatus && node.healthStatus !== 'Unknown' && (
                      <StatusBadge status={node.healthStatus} />
                    )}
                    {node.syncStatus && <span className="resource-sync">{node.syncStatus}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
