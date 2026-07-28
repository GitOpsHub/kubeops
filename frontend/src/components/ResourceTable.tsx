import { useState } from 'react'
import type { ResourceNode } from '../api/onboarding'
import { sortResources, type SortColumn, type SortDirection } from '../lib/resource-graph'
import { age } from '../lib/resource-tree'
import { StatusBadge } from './StatusBadge'

const columns: { id: SortColumn; label: string }[] = [
  { id: 'kind', label: 'Kind' },
  { id: 'name', label: 'Name' },
  { id: 'namespace', label: 'Namespace' },
  { id: 'healthStatus', label: 'Health' },
  { id: 'syncStatus', label: 'Sync' },
  { id: 'createdAt', label: 'Age' },
]

type Props = {
  nodes: ResourceNode[]
  onSelect: (node: ResourceNode) => void
  onDelete: (node: ResourceNode) => void
}

/**
 * The flat view of the same resources. Sorting and filtering are what this
 * buys over the graph — finding one pod among ninety — so hierarchy is
 * deliberately dropped here rather than half-represented.
 */
export function ResourceTable({ nodes, onSelect, onDelete }: Props) {
  const [column, setColumn] = useState<SortColumn>('kind')
  const [direction, setDirection] = useState<SortDirection>('asc')
  const [kind, setKind] = useState('')

  const kinds = [...new Set(nodes.map((node) => node.kind))].sort()
  const filtered = kind ? nodes.filter((node) => node.kind === kind) : nodes
  const sorted = sortResources(filtered, column, direction)

  function toggleSort(next: SortColumn) {
    if (next === column) {
      setDirection((current) => (current === 'asc' ? 'desc' : 'asc'))
      return
    }
    setColumn(next)
    setDirection('asc')
  }

  return (
    <div className="resource-table">
      <div className="filter-bar">
        <label>
          <span>Kind</span>
          <select value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="">All kinds</option>
            {kinds.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        {kind && (
          <button type="button" className="clear-filters" onClick={() => setKind('')}>
            Clear filter
          </button>
        )}
      </div>

      <div className="table-frame">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {columns.map((item) => (
                  <th
                    key={item.id}
                    aria-sort={
                      column === item.id
                        ? direction === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                    }
                  >
                    <button
                      type="button"
                      className="column-sort"
                      onClick={() => toggleSort(item.id)}
                    >
                      {item.label}
                      <span aria-hidden="true" className="sort-caret">
                        {column === item.id ? (direction === 'asc' ? '↑' : '↓') : ''}
                      </span>
                    </button>
                  </th>
                ))}
                <th aria-label="Row actions" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((node) => (
                <tr key={node.uid} className="row-clickable" onClick={() => onSelect(node)}>
                  <td>
                    <span className="resource-kind">{node.kind}</span>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="resource-name-button"
                      onClick={(event) => {
                        event.stopPropagation()
                        onSelect(node)
                      }}
                    >
                      {node.name}
                    </button>
                  </td>
                  <td className="mono">{node.namespace || '—'}</td>
                  <td>
                    {node.healthStatus && node.healthStatus !== 'Unknown' ? (
                      <StatusBadge status={node.healthStatus} />
                    ) : (
                      <span className="resource-sync">—</span>
                    )}
                  </td>
                  <td>
                    <span className="resource-sync">{node.syncStatus || '—'}</span>
                  </td>
                  <td className="numeric">{age(node.createdAt)}</td>
                  <td className="actions-cell">
                    <button
                      type="button"
                      className="resource-delete"
                      aria-label={`Delete ${node.kind} ${node.name}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        onDelete(node)
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
