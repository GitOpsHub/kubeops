import { onboardingStatuses } from '../../api/onboarding'
import { SortAscendingIcon, SortDescendingIcon } from '../../components/icons'
import { Button } from '../../components/ui/Button'
import { SearchInput } from '../../components/ui/SearchInput'
import { StatusDot } from '../../components/ui/StatusDot'
import { statusMeta } from '../../lib/status'
import { sortLabels, type SortKey } from './application-groups'
import type { ApplicationsQuery } from './useApplicationsQuery'

type Props = {
  query: ApplicationsQuery
  /** Tiles have no column headers, so they get a sort control here instead. */
  showSort: boolean
}

export function ApplicationFilters({ query, showSort }: Props) {
  const { filters, updateParams, statusCounts, environmentOptions } = query
  const { status, environment, search, sortKey, sortDirection } = filters

  return (
    <div className="application-filters" role="search" aria-label="Filter applications">
      <div className="application-filter-row">
        <label className="field application-search">
          <span>Application or namespace</span>
          <SearchInput
            label="Search applications by name or namespace"
            placeholder="Search applications"
            value={filters.searchDraft}
            onChange={query.setSearchDraft}
          />
        </label>
        <label className="field">
          <span>Environment</span>
          <select
            className="select"
            value={environment}
            onChange={(event) => updateParams({ environment: event.target.value })}
          >
            <option value="">All environments</option>
            {environmentOptions.map((item) => (
              <option value={item} key={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Status</span>
          <select
            className="select"
            value={status}
            onChange={(event) => updateParams({ status: event.target.value })}
          >
            <option value="">All statuses</option>
            {onboardingStatuses.map((item) => (
              <option value={item} key={item}>
                {statusMeta('lifecycle', item).label}
              </option>
            ))}
          </select>
        </label>
        {showSort && (
          <div className="field">
            <span id="tile-sort-label">Sort by</span>
            <div className="tile-sort">
              <select
                className="select"
                aria-labelledby="tile-sort-label"
                value={sortKey}
                onChange={(event) => updateParams({ sort: event.target.value })}
              >
                {(Object.keys(sortLabels) as SortKey[]).map((key) => (
                  <option value={key} key={key}>
                    {sortLabels[key]}
                  </option>
                ))}
              </select>
              <Button
                iconOnly
                aria-label={`Sort ${sortDirection === 'asc' ? 'descending' : 'ascending'}`}
                title={sortDirection === 'asc' ? 'Ascending' : 'Descending'}
                onClick={() =>
                  updateParams({ sort: sortKey, dir: sortDirection === 'asc' ? 'desc' : 'asc' })
                }
              >
                {sortDirection === 'asc' ? <SortAscendingIcon /> : <SortDescendingIcon />}
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="application-filter-summary">
        {/* "What is broken" should be one click, not a trip through a select.
            The strip and the Status select write the same URL value. */}
        <div className="status-strip" role="group" aria-label="Filter by status">
          <button
            type="button"
            className={`status-strip-item${status ? '' : ' is-active'}`}
            aria-pressed={!status}
            onClick={() => updateParams({ status: '' })}
          >
            <span className="status-strip-label">All</span> <strong>{query.scopedTotal}</strong>
          </button>
          {statusCounts.map((entry) => {
            const meta = statusMeta('lifecycle', entry.status)
            const active = status === entry.status
            return (
              <button
                type="button"
                key={entry.status}
                className={`status-strip-item status-chip--${entry.status}${
                  active ? ' is-active' : ''
                }${entry.count === 0 ? ' is-empty' : ''}`}
                aria-pressed={active}
                data-tone={meta.tone}
                onClick={() => updateParams({ status: active ? '' : entry.status })}
              >
                <StatusDot tone={meta.tone} size="sm" plain />
                <span className="status-strip-label">{meta.label}</span>{' '}
                <strong>{entry.count}</strong>
              </button>
            )
          })}
          {query.scopedTotal > 0 && (
            <span className="status-strip-bar" aria-hidden="true">
              {statusCounts
                .filter((entry) => entry.count > 0)
                .map((entry) => (
                  <span
                    key={entry.status}
                    data-tone={statusMeta('lifecycle', entry.status).tone}
                    style={{ flexGrow: entry.count }}
                  />
                ))}
            </span>
          )}
        </div>

        {(search || environment) && (
          <div className="chip-row">
            {search && (
              <span className="chip">
                Name <strong>{search}</strong>
                <button
                  type="button"
                  className="chip-remove"
                  aria-label={`Remove name filter ${search}`}
                  onClick={query.clearSearch}
                >
                  ×
                </button>
              </span>
            )}
            {environment && (
              <span className="chip">
                Environment <strong>{environment}</strong>
                <button
                  type="button"
                  className="chip-remove"
                  aria-label={`Remove environment filter ${environment}`}
                  onClick={() => updateParams({ environment: '' })}
                >
                  ×
                </button>
              </span>
            )}
          </div>
        )}
        {query.hasFilters && (
          <button type="button" className="link-button" onClick={query.clearAllFilters}>
            Clear filters
          </button>
        )}
      </div>
    </div>
  )
}
