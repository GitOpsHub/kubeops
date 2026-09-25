import { useState } from 'react'
import { isLoggableKind } from '../../api/argo'
import type { ResourceNode } from '../../api/onboarding'
import { KubernetesResourceIcon } from '../../components/KubernetesResourceIcon'
import { StatusBadge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { DataTable, type Column } from '../../components/ui/DataTable'
import { age } from '../../lib/format'
import {
  resourceSyncLabel,
  sortResources,
  type SortColumn,
  type SortDirection,
} from '../../lib/resource-graph'

type Props = {
  nodes: ResourceNode[]
  onSelect: (node: ResourceNode) => void
  onDelete: (node: ResourceNode) => void
  /** Opens logs; offered only on kinds that have them (pods and workloads). */
  onLogs?: (node: ResourceNode) => void
}

/**
 * The flat view of the same resources. Sorting and filtering are what this
 * buys over the graph — finding one pod among ninety — so hierarchy is
 * deliberately dropped here rather than half-represented. Rows open the YAML
 * on click, Enter, or Space.
 */
export function ResourceTable({ nodes, onSelect, onDelete, onLogs }: Props) {
  const [column, setColumn] = useState<SortColumn>('kind')
  const [direction, setDirection] = useState<SortDirection>('asc')
  const [kind, setKind] = useState('')

  const kinds = [...new Set(nodes.map((node) => node.kind))].sort()
  const filtered = kind ? nodes.filter((node) => node.kind === kind) : nodes
  const sorted = sortResources(filtered, column, direction)

  function toggleSort(next: string) {
    if (next === column) {
      setDirection((current) => (current === 'asc' ? 'desc' : 'asc'))
      return
    }
    setColumn(next as SortColumn)
    setDirection('asc')
  }

  const columns: Column<ResourceNode>[] = [
    {
      id: 'kind',
      header: 'Kind',
      sortable: true,
      cell: (node) => (
        <span className="resource-kind">
          <KubernetesResourceIcon kind={node.kind} className="resource-kind-icon" />
          {node.kind}
        </span>
      ),
    },
    {
      id: 'name',
      header: 'Name',
      sortable: true,
      cell: (node) => (
        <span className="mono resource-name" title={node.name}>
          {node.name}
        </span>
      ),
    },
    {
      id: 'namespace',
      header: 'Namespace',
      sortable: true,
      className: 'mono cell-muted',
      cell: (node) => node.namespace || '—',
    },
    {
      id: 'healthStatus',
      header: 'Health',
      sortable: true,
      cell: (node) =>
        node.healthStatus && node.healthStatus !== 'Unknown' ? (
          <StatusBadge domain="health" status={node.healthStatus} />
        ) : (
          <span className="subtle">—</span>
        ),
    },
    {
      id: 'syncStatus',
      header: 'Sync',
      sortable: true,
      // Pods and other owned objects are not tracked for sync; a dash says so.
      cell: (node) =>
        node.syncStatus ? (
          <StatusBadge domain="sync" status={node.syncStatus} label={resourceSyncLabel(node)} />
        ) : (
          <span className="subtle">—</span>
        ),
    },
    {
      id: 'createdAt',
      header: 'Age',
      sortable: true,
      align: 'end',
      className: 'cell-numeric cell-muted',
      cell: (node) => age(node.createdAt),
    },
    {
      id: 'actions',
      header: '',
      headerLabel: 'Row actions',
      align: 'end',
      cell: (node) => (
        <span className="resource-row-actions">
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Info for ${node.kind} ${node.name}`}
            onClick={(event) => {
              event.stopPropagation()
              onSelect(node)
            }}
          >
            Info
          </Button>
          {onLogs && isLoggableKind(node.kind) && (
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Logs for ${node.kind} ${node.name}`}
              onClick={(event) => {
                event.stopPropagation()
                onLogs(node)
              }}
            >
              Logs
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="resource-delete"
            aria-label={`Delete ${node.kind} ${node.name}`}
            onClick={(event) => {
              event.stopPropagation()
              onDelete(node)
            }}
          >
            Delete
          </Button>
        </span>
      ),
    },
  ]

  return (
    <div className="panel">
      <div className="panel-subheader">
        <label className="resource-kind-filter">
          <span>Kind</span>
          <select className="select" value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="">All kinds</option>
            {kinds.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        {kind && (
          <button type="button" className="link-button" onClick={() => setKind('')}>
            Clear filter
          </button>
        )}
        <span className="resource-count">
          {kind ? `${sorted.length} of ${nodes.length}` : nodes.length}{' '}
          {nodes.length === 1 ? 'resource' : 'resources'}
        </span>
      </div>
      <DataTable
        label="Kubernetes resources"
        columns={columns}
        rows={sorted}
        rowKey={(node) => node.uid}
        sort={{ column, direction }}
        onSort={toggleSort}
        onRowClick={onSelect}
        rowLabel={(node) => `${node.kind} ${node.name}`}
      />
    </div>
  )
}
