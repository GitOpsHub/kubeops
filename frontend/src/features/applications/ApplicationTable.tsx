import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { CloudSource } from '../../api/inventory'
import { ArgoIcon } from '../../components/icons'
import { StateDelta, StateDeltaLegend } from '../../components/StateDelta'
import { StatusBadge } from '../../components/ui/Badge'
import { DataTable, type Column } from '../../components/ui/DataTable'
import { plural } from '../../lib/format'
import { deltaTone, deltaToneColour, environmentTone, rollupState } from '../../lib/status'
import {
  flattenTargets,
  namespaceLabel,
  type ApplicationGroup,
  type SortDirection,
  type SortKey,
} from './application-groups'
import { EnvironmentTags, PlatformIds } from './PlatformIds'

type Props = {
  groups: ApplicationGroup[]
  sources: Map<string, CloudSource>
  sortKey: SortKey
  sortDirection: SortDirection
  onSort: (key: SortKey) => void
  /** Changes whenever the visible set does, so stale expansions are dropped. */
  viewKey: string
}

function targetsRowId(group: ApplicationGroup) {
  return `application-targets-${group.key}`
}

/**
 * The sortable table view. Each row expands into one flat table of its
 * deployment targets, ordered the way an operator promotes.
 */
export function ApplicationTable({
  groups,
  sources,
  sortKey,
  sortDirection,
  onSort,
  viewKey,
}: Props) {
  const [expanded, setExpanded] = useState<string[]>([])

  // Rows that page or filter out of view do not stay armed to reopen.
  useEffect(() => {
    const visible = new Set(groups.map((group) => group.key))
    setExpanded((current) => {
      const next = current.filter((key) => visible.has(key))
      return next.length === current.length ? current : next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey])

  function toggle(key: string) {
    setExpanded((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    )
  }

  const columns: Column<ApplicationGroup>[] = [
    {
      id: 'expander',
      header: null,
      headerLabel: 'Expand row',
      className: 'col-expander',
      cell: (group) => {
        const isExpanded = expanded.includes(group.key)
        return (
          <button
            type="button"
            className="row-expander"
            aria-expanded={isExpanded}
            aria-controls={targetsRowId(group)}
            aria-label={`${isExpanded ? 'Hide' : 'Show'} deployment targets for ${group.name}`}
            onClick={() => toggle(group.key)}
          >
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="M4 2l4 4-4 4" />
            </svg>
          </button>
        )
      },
    },
    {
      id: 'name',
      header: 'Application',
      sortable: true,
      // Namespace rides under the name: it confirms the row rather than being
      // scanned. The UUID lives in the title and the expanded header, where
      // it can be copied.
      cell: (group) => {
        const namespace = namespaceLabel(group)
        return (
          <span className="cell-stack">
            <Link
              className="application-name"
              to={`/applications/${group.applicationId}`}
              title={`${group.name} · ${group.applicationId}`}
            >
              {group.name}
            </Link>
            <small className="mono truncate" title={namespace}>
              {namespace}
            </small>
          </span>
        )
      },
    },
    {
      id: 'platform',
      header: 'Platform',
      cell: (group) => <PlatformIds ids={group.platformIds} sources={sources} />,
    },
    {
      // Environment and region are one thought: where it runs.
      id: 'scope',
      header: 'Scope',
      cell: (group) => (
        <span className="cell-stack">
          <EnvironmentTags environments={group.environments} />
          <small className="mono truncate" title={group.regions.join(', ')}>
            {group.regions.length > 0 ? group.regions.join(' · ') : '—'}
          </small>
        </span>
      ),
    },
    {
      id: 'targets',
      header: 'Releases',
      sortable: true,
      cell: (group) => (
        <span className="cell-stack">
          {plural(group.records.length, 'release')}
          <small>{plural(group.targets.length, 'target')}</small>
        </span>
      ),
    },
    {
      id: 'reconciliation',
      header: 'Reconciliation',
      cell: (group) => {
        const rollup = rollupState(group.targets)
        return <StateDelta syncStatus={rollup.syncStatus} healthStatus={rollup.healthStatus} />
      },
    },
    {
      id: 'status',
      header: 'Status',
      sortable: true,
      cell: (group) => <StatusBadge domain="lifecycle" status={group.status} />,
    },
  ]

  return (
    <>
      <StateDeltaLegend />
      <DataTable
        label="Applications"
        className="applications-table-frame"
        columns={columns}
        rows={groups}
        rowKey={(group) => group.key}
        sort={{ column: sortKey, direction: sortDirection }}
        onSort={(column) => onSort(column as SortKey)}
        rowClassName={(group) => (expanded.includes(group.key) ? 'is-expanded' : '')}
        expandedRowId={targetsRowId}
        renderExpanded={(group) =>
          expanded.includes(group.key) ? <DeploymentTargets group={group} /> : null
        }
      />
    </>
  )
}

function DeploymentTargets({ group }: { group: ApplicationGroup }) {
  return (
    <div className="application-targets">
      <div className="application-targets-heading">
        <code title={group.applicationId}>ID {group.applicationId}</code>
        <Link to={`/applications/${group.applicationId}`}>Open application →</Link>
      </div>
      <table
        className="data-table target-table"
        aria-label={`Deployment targets for ${group.name}`}
      >
        <thead>
          <tr>
            <th>Environment</th>
            <th>Region</th>
            <th>Namespace</th>
            <th>Cluster</th>
            <th>Reconciliation</th>
            <th>Status</th>
            <th>Argo</th>
          </tr>
        </thead>
        <tbody>
          {flattenTargets(group.records).map((row) => (
            <tr
              key={row.key}
              className="target-row"
              data-tone={
                row.target
                  ? deltaToneColour(deltaTone(row.target.syncStatus, row.target.healthStatus))
                  : undefined
              }
            >
              <td>
                <span
                  className={`environment-tag environment-tag--${row.environment}`}
                  data-tone={environmentTone(row.environment)}
                >
                  {row.environment}
                </span>
              </td>
              <td className="mono">{row.region || '—'}</td>
              <td className="mono" title={row.namespace}>
                {row.namespace}
              </td>
              <td className="mono" title={row.target?.clusterName ?? undefined}>
                {row.target?.clusterName ?? <span className="subtle">No targets</span>}
              </td>
              <td>
                {row.target ? (
                  <StateDelta
                    syncStatus={row.target.syncStatus}
                    healthStatus={row.target.healthStatus}
                  />
                ) : (
                  '—'
                )}
              </td>
              <td>
                {row.target ? <StatusBadge domain="lifecycle" status={row.target.status} /> : '—'}
              </td>
              <td>
                {row.target?.argoApplicationUrl ? (
                  <a
                    className="argo-link"
                    href={row.target.argoApplicationUrl}
                    target="_blank"
                    rel="noreferrer"
                    title={row.target.argoApplication}
                    aria-label={`Open ${row.target.clusterName} in Argo CD`}
                  >
                    <ArgoIcon aria-hidden="true" />
                    Open
                  </a>
                ) : (
                  <span className="mono subtle" title={row.target?.argoApplication}>
                    {row.target?.argoApplication ?? '—'}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
