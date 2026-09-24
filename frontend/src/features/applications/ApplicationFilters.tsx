import { onboardingStatuses } from '../../api/onboarding'
import { SearchInput } from '../../components/ui/SearchInput'
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
                {item}
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
              <button
                type="button"
                className="btn btn--secondary btn--md btn--icon"
                aria-label={`Sort ${sortDirection === 'asc' ? 'descending' : 'ascending'}`}
                title={sortDirection === 'asc' ? 'Ascending' : 'Descending'}
                onClick={() =>
                  updateParams({ sort: sortKey, dir: sortDirection === 'asc' ? 'desc' : 'asc' })
                }
              >
                {sortDirection === 'asc' ? '↑' : '↓'}
              </button>
            </div>
          </div>
        )}
      </div>

      {(statusCounts.length > 0 || query.hasFilters) && (
        <div className="application-filter-summary">
          {/* "What is broken" should be one click, not a trip through a select. */}
          {statusCounts.length > 0 && (
            <div className="status-chips" role="group" aria-label="Filter by status">
              {statusCounts.map((entry) => (
                <button
                  type="button"
                  key={entry.status}
                  className={`status-chip status-chip--${entry.status}${
                    status === entry.status ? ' is-active' : ''
                  }`}
                  aria-pressed={status === entry.status}
                  onClick={() =>
                    updateParams({ status: status === entry.status ? '' : entry.status })
                  }
                >
                  <strong>{entry.count}</strong> {entry.status}
                </button>
              ))}
            </div>
          )}

          {query.hasFilters && (
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
              {status && (
                <span className="chip">
                  Status <strong>{status}</strong>
                  <button
                    type="button"
                    className="chip-remove"
                    aria-label={`Remove status filter ${status}`}
                    onClick={() => updateParams({ status: '' })}
                  >
                    ×
                  </button>
                </span>
              )}
              <button type="button" className="link-button" onClick={query.clearAllFilters}>
                Clear filters
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
