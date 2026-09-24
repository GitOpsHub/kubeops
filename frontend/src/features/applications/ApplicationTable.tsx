import { Fragment, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { StateDelta, StateDeltaLegend } from '../../components/StateDelta'
import { StatusBadge } from '../../components/ui/Badge'
import { SortCaret } from '../../components/ui/DataTable'
import { sortState } from '../../components/ui/table-sort'
import { plural } from '../../lib/format'
import { deltaTone, rollupState } from '../../lib/status'
import {
  flattenTargets,
  namespaceLabel,
  type ApplicationGroup,
  type SortDirection,
  type SortKey,
} from './application-groups'
import { EnvironmentTags, PlatformIds } from './PlatformIds'
import '../../components/ui/DataTable.css'

type Props = {
  groups: ApplicationGroup[]
  sortKey: SortKey
  sortDirection: SortDirection
  onSort: (key: SortKey) => void
  /** Changes whenever the visible set does, so stale expansions are dropped. */
  viewKey: string
}

const toneClass: Record<string, string> = {
  converged: 'target-row--ok',
  reconciling: 'target-row--warn',
  diverged: 'target-row--err',
  unknown: '',
}

/**
 * The sortable table view. Rows expand into one flat table of deployment
 * targets, so it is hand-built rather than a `DataTable`; it shares that
 * primitive's styles and sort affordance.
 */
export function ApplicationTable({ groups, sortKey, sortDirection, onSort, viewKey }: Props) {
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

  function header(key: SortKey, label: string) {
    return (
      <button type="button" className="column-sort" onClick={() => onSort(key)}>
        {label}
        <SortCaret active={key === sortKey} direction={sortDirection} />
      </button>
    )
  }

  return (
    <>
      <StateDeltaLegend />
      <div className="table-scroll">
        <table className="data-table applications-table">
          <thead>
            <tr>
              <th className="col-expander" aria-label="Expand row" />
              <th aria-sort={sortState(sortKey === 'name', sortDirection)}>
                {header('name', 'Application')}
              </th>
              <th>Platform</th>
              <th>Scope</th>
              <th aria-sort={sortState(sortKey === 'targets', sortDirection)}>
                {header('targets', 'Releases')}
              </th>
              <th>Reconciliation</th>
              <th aria-sort={sortState(sortKey === 'status', sortDirection)}>
                {header('status', 'Status')}
              </th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => {
              const isExpanded = expanded.includes(group.key)
              const rollup = rollupState(group.targets)
              const namespace = namespaceLabel(group)
              const targetsRowId = `application-targets-${group.key}`
              return (
                <Fragment key={group.key}>
                  <tr className={isExpanded ? 'is-expanded' : undefined}>
                    <td className="col-expander">
                      <button
                        type="button"
                        className="row-expander"
                        aria-expanded={isExpanded}
                        aria-controls={targetsRowId}
                        aria-label={`${isExpanded ? 'Hide' : 'Show'} deployment targets for ${group.name}`}
                        onClick={() => toggle(group.key)}
                      >
                        <svg viewBox="0 0 12 12" aria-hidden="true">
                          <path d="M4 2l4 4-4 4" />
                        </svg>
                      </button>
                    </td>
                    {/* Namespace rides under the name: it confirms the row
                        rather than being scanned. The UUID lives in the title
                        and the expanded header, where it can be copied. */}
                    <td>
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
                    </td>
                    <td>
                      <PlatformIds ids={group.platformIds} />
                    </td>
                    {/* Environment and region are one thought: where it runs. */}
                    <td>
                      <span className="cell-stack">
                        <EnvironmentTags environments={group.environments} />
                        <small className="mono truncate" title={group.regions.join(', ')}>
                          {group.regions.length > 0 ? group.regions.join(' · ') : '—'}
                        </small>
                      </span>
                    </td>
                    <td>
                      <span className="cell-stack">
                        {plural(group.records.length, 'release')}
                        <small>{plural(group.targets.length, 'target')}</small>
                      </span>
                    </td>
                    <td>
                      <StateDelta
                        syncStatus={rollup.syncStatus}
                        healthStatus={rollup.healthStatus}
                      />
                    </td>
                    <td>
                      <StatusBadge status={group.status} />
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr className="expanded-row" id={targetsRowId}>
                      <td colSpan={7}>
                        <div className="application-targets">
                          <div className="application-targets-heading">
                            <code title={group.applicationId}>ID {group.applicationId}</code>
                            <Link to={`/applications/${group.applicationId}`}>
                              Open application →
                            </Link>
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
                                  className={
                                    row.target
                                      ? toneClass[
                                          deltaTone(row.target.syncStatus, row.target.healthStatus)
                                        ] || undefined
                                      : undefined
                                  }
                                >
                                  <td>
                                    <span
                                      className={`environment-tag environment-tag--${row.environment}`}
                                    >
                                      {row.environment}
                                    </span>
                                  </td>
                                  <td className="mono">{row.region || '—'}</td>
                                  <td className="mono" title={row.namespace}>
                                    {row.namespace}
                                  </td>
                                  <td className="mono" title={row.target?.clusterName ?? undefined}>
                                    {row.target?.clusterName ?? (
                                      <span className="subtle">No targets</span>
                                    )}
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
                                    {row.target ? <StatusBadge status={row.target.status} /> : '—'}
                                  </td>
                                  <td>
                                    {row.target?.argoApplicationUrl ? (
                                      <a
                                        href={row.target.argoApplicationUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                        title={row.target.argoApplication}
                                      >
                                        Open
                                      </a>
                                    ) : (
                                      <span
                                        className="mono subtle"
                                        title={row.target?.argoApplication}
                                      >
                                        {row.target?.argoApplication ?? '—'}
                                      </span>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}
