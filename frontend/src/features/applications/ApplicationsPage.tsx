import { Link } from 'react-router-dom'
import { KubernetesLogo } from '../../components/BrandIcons'
import { Banner } from '../../components/ui/Banner'
import { Button } from '../../components/ui/Button'
import { buttonClass } from '../../components/ui/button-class'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageHeader } from '../../components/ui/PageHeader'
import { Pagination } from '../../components/ui/Pagination'
import { RefreshIndicator } from '../../components/ui/RefreshIndicator'
import { SegmentedControl } from '../../components/ui/SegmentedControl'
import { SkeletonCards, SkeletonRows } from '../../components/ui/Skeleton'
import { useStoredPreference } from '../../hooks/useStoredPreference'
import { ApplicationFilters } from './ApplicationFilters'
import { ApplicationTable } from './ApplicationTable'
import { ApplicationTiles } from './ApplicationTiles'
import { pageSizeOptions, useApplicationsQuery } from './useApplicationsQuery'
import '../../components/ui/DataTable.css'
import './applications.css'

type ViewMode = 'tiles' | 'table'

const TilesIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
    <rect x="1.5" y="1.5" width="5.4" height="5.4" rx="1.2" />
    <rect x="9.1" y="1.5" width="5.4" height="5.4" rx="1.2" />
    <rect x="1.5" y="9.1" width="5.4" height="5.4" rx="1.2" />
    <rect x="9.1" y="9.1" width="5.4" height="5.4" rx="1.2" />
  </svg>
)

const TableIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
    <rect x="1.5" y="2.2" width="13" height="2.6" rx="1" />
    <rect x="1.5" y="6.7" width="13" height="2.6" rx="1" />
    <rect x="1.5" y="11.2" width="13" height="2.6" rx="1" />
  </svg>
)

export function ApplicationsPage() {
  // Tiles are the default read; the table stays one click away for operators
  // who want columns to sort and compare.
  const [view, setView] = useStoredPreference<ViewMode>('kubeops.applications.view', 'tiles')
  const apps = useApplicationsQuery()
  const { query, items, filters, filteredGroups, visibleGroups } = apps
  const { page, pageSize } = filters
  const waiting = query.loading || (query.error !== null && items.length === 0)

  return (
    <section className="page" aria-labelledby="applications-heading">
      <PageHeader
        id="applications-heading"
        title="Applications"
        description="Releases, target health, and reconciliation across the fleet."
        actions={
          <>
            <SegmentedControl<ViewMode>
              label="Applications view"
              value={view}
              onChange={setView}
              options={[
                { value: 'tiles', label: 'Tiles', icon: <TilesIcon />, title: 'Tile view' },
                { value: 'table', label: 'Table', icon: <TableIcon />, title: 'Table view' },
              ]}
            />
            <Link className={buttonClass('primary')} to="/applications/new">
              Onboard application
            </Link>
          </>
        }
        meta={
          <RefreshIndicator
            lastUpdated={query.lastUpdated}
            refreshing={query.refreshing}
            failed={Boolean(query.error)}
          />
        }
      />

      {/* With rows on screen a failed poll is a stale-data warning. With nothing
          on screen it is still a load in progress, and the panel below says so
          rather than claiming the fleet is empty. */}
      {query.error && items.length > 0 && (
        <Banner
          tone="error"
          title="Applications could not be refreshed"
          onRetry={() => void query.reload()}
        >
          {query.error.message}
        </Banner>
      )}

      <div className="panel">
        <ApplicationFilters query={apps} showSort={view === 'tiles'} />

        {waiting ? (
          <div className="application-loading" role="status">
            <div className="application-loading-copy">
              {!query.error && <span className="spinner" aria-hidden="true" />}
              <strong>Loading applications…</strong>
              {query.error && <span>Last attempt failed: {query.error.message}</span>}
              {!query.loading && query.error && (
                <button type="button" className="link-button" onClick={() => void query.reload()}>
                  Try again
                </button>
              )}
            </div>
            {view === 'tiles' ? (
              <div className="application-tiles-frame">
                <SkeletonCards count={6} />
              </div>
            ) : (
              <SkeletonRows rows={6} columns={6} />
            )}
          </div>
        ) : filteredGroups.length === 0 ? (
          <EmptyState
            icon={<KubernetesLogo />}
            title={
              apps.hasFilters ? 'Nothing matches those filters' : 'No applications onboarded yet'
            }
            description={
              apps.hasFilters
                ? 'Try a different search, or clear the filters to see everything.'
                : 'Onboard one and its clusters, sync state, and health show up here.'
            }
            action={
              apps.hasFilters ? (
                <Button size="sm" onClick={apps.clearAllFilters}>
                  Clear filters
                </Button>
              ) : (
                <Link className={buttonClass('primary', 'sm')} to="/applications/new">
                  Onboard application
                </Link>
              )
            }
          />
        ) : view === 'tiles' ? (
          <div className="application-tiles-frame">
            <ApplicationTiles groups={visibleGroups} sources={apps.sources} />
          </div>
        ) : (
          <ApplicationTable
            groups={visibleGroups}
            sources={apps.sources}
            sortKey={filters.sortKey}
            sortDirection={filters.sortDirection}
            onSort={apps.toggleSort}
            viewKey={[
              page,
              pageSize,
              filters.search,
              filters.status,
              filters.environment,
              filters.sortKey,
              filters.sortDirection,
            ].join('|')}
          />
        )}

        <Pagination
          page={page}
          pageSize={pageSize}
          total={filteredGroups.length}
          pageSizeOptions={pageSizeOptions}
          onPageChange={(next) => apps.updateParams({ page: String(next) }, false)}
          onPageSizeChange={(size) => apps.updateParams({ pageSize: String(size) })}
          noun={['application', 'applications']}
          summary="range"
          pageSizeLabel="Applications per page"
          label="Applications pagination"
        />
      </div>
    </section>
  )
}
