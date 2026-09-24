import { useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { errorMessage } from '../../api/client'
import {
  getClusters,
  getSources,
  getSyncRuns,
  type CloudSource,
  type SyncRun,
} from '../../api/inventory'
import {
  getAllApplicationOnboardings,
  onboardingStatuses,
  type OnboardingStatus,
} from '../../api/onboarding'
import { ProviderLogo } from '../../components/BrandIcons'
import { Banner } from '../../components/ui/Banner'
import { StatusBadge } from '../../components/ui/Badge'
import { buttonClass } from '../../components/ui/button-class'
import { Card } from '../../components/ui/Card'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageHeader } from '../../components/ui/PageHeader'
import { RefreshIndicator } from '../../components/ui/RefreshIndicator'
import { Skeleton } from '../../components/ui/Skeleton'
import { StatCard } from '../../components/ui/StatCard'
import { usePolledResource } from '../../hooks/usePolledResource'
import { isOlderThan, plural, relativeTime } from '../../lib/format'
import {
  emptyProviderCounts,
  providerLabels,
  providerNames,
  providers,
  staleAfterMs,
} from '../../lib/providers'
import {
  groupApplications,
  statusSeverity,
  type ApplicationGroup,
} from '../applications/application-groups'
import './overview.css'

const pollIntervalMs = 30_000

type OverviewData = {
  clusterTotal: number | null
  sources: CloudSource[] | null
  runs: SyncRun[] | null
  groups: ApplicationGroup[] | null
  failures: string[]
}

/**
 * Four independent reads. One of them failing (Argo CD down, say) should not
 * blank the other three, so each settles on its own and the page reports
 * which parts are missing. Only when every read fails does the whole load
 * count as failed, which is what lets the polling hook back off.
 */
async function loadOverview(signal: AbortSignal): Promise<OverviewData> {
  const [clusters, sources, runs, applications] = await Promise.allSettled([
    getClusters({ page: 1, pageSize: 1 }, signal),
    getSources(signal),
    getSyncRuns(signal),
    getAllApplicationOnboardings({}, signal),
  ])
  const results = [clusters, sources, runs, applications]
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  )
  if (rejected.length === results.length) throw rejected[0].reason

  const value = <T,>(result: PromiseSettledResult<T>) =>
    result.status === 'fulfilled' ? result.value : null
  const clusterPage = value(clusters)
  const onboardings = value(applications)
  return {
    clusterTotal: clusterPage?.total ?? null,
    sources: value(sources),
    runs: value(runs),
    groups: onboardings ? groupApplications(onboardings) : null,
    failures: [...new Set(rejected.map((result) => errorMessage(result.reason, 'Request failed')))],
  }
}

function sourceNeedsAttention(source: CloudSource) {
  return (
    source.enabled &&
    (source.lastSyncStatus === 'failed' || isOlderThan(source.lastSyncAt, staleAfterMs))
  )
}

const healthOrder: OnboardingStatus[] = [...onboardingStatuses].sort(
  (left, right) => statusSeverity[right] - statusSeverity[left],
)

export function OverviewPage() {
  const load = useCallback((signal: AbortSignal) => loadOverview(signal), [])
  const overview = usePolledResource(load, { intervalMs: pollIntervalMs })
  const data = overview.data

  const summary = useMemo(() => {
    if (!data) return null
    const providerCounts = emptyProviderCounts()
    for (const source of data.sources ?? []) providerCounts[source.provider] += source.clusterCount
    const statusCounts = new Map<OnboardingStatus, number>()
    for (const group of data.groups ?? []) {
      statusCounts.set(group.status, (statusCounts.get(group.status) ?? 0) + 1)
    }
    const attentionApps = (data.groups ?? [])
      .filter((group) => group.status === 'failed' || group.status === 'partial')
      .sort((left, right) => statusSeverity[left.status] - statusSeverity[right.status])
    const attentionSources = (data.sources ?? []).filter(sourceNeedsAttention)
    const failedRuns = (data.runs ?? []).filter((run) => run.status === 'failed')
    return { providerCounts, statusCounts, attentionApps, attentionSources, failedRuns }
  }, [data])

  const providerMax = summary ? Math.max(1, ...Object.values(summary.providerCounts)) : 1
  const fleetTotal = summary
    ? Object.values(summary.providerCounts).reduce((sum, count) => sum + count, 0)
    : 0
  const groupCount = data?.groups?.length ?? 0

  return (
    <section className="page" aria-labelledby="overview-heading">
      <PageHeader
        id="overview-heading"
        title="Overview"
        description="Fleet health across every connected cloud source and Argo CD target."
        actions={
          <Link className={buttonClass('primary')} to="/applications/new">
            Onboard application
          </Link>
        }
        meta={
          <RefreshIndicator
            lastUpdated={overview.lastUpdated}
            refreshing={overview.refreshing}
            failed={Boolean(overview.error)}
          />
        }
      />

      {overview.error && (
        <Banner
          tone="error"
          title={data ? 'Overview could not be refreshed' : 'Overview could not be loaded'}
          onRetry={() => void overview.reload()}
        >
          {overview.error.message}
        </Banner>
      )}
      {!overview.error && data && data.failures.length > 0 && (
        <Banner tone="warn" title="Some data is unavailable" onRetry={() => void overview.reload()}>
          {data.failures.join(' · ')}
        </Banner>
      )}

      {/* After a total failure the banner says so; skeletons would imply a
          load still in progress. */}
      {(data || !overview.error) && (
        <>
          <div className="overview-stats">
            {!summary ? (
              Array.from({ length: 4 }, (_, index) => (
                <Skeleton key={index} height={108} radius="var(--radius-lg)" />
              ))
            ) : (
              <>
                <StatCard
                  label="Clusters"
                  value={data?.clusterTotal ?? fleetTotal}
                  hint={`across ${plural(data?.sources?.filter((source) => source.enabled).length ?? 0, 'active source')}`}
                  to="/clusters"
                />
                <StatCard
                  label="Applications"
                  value={groupCount}
                  hint={`${summary.statusCounts.get('healthy') ?? 0} healthy`}
                  to="/applications"
                />
                <StatCard
                  label="Need attention"
                  value={summary.attentionApps.length}
                  tone={summary.attentionApps.length > 0 ? 'err' : 'ok'}
                  hint={
                    summary.attentionApps.length > 0
                      ? 'failed or partial applications'
                      : 'all applications settled'
                  }
                  to="/applications?sort=status"
                />
                <StatCard
                  label="Sync issues"
                  value={summary.attentionSources.length}
                  tone={summary.attentionSources.length > 0 ? 'warn' : 'ok'}
                  hint={
                    summary.attentionSources.length > 0
                      ? 'sources failing or behind'
                      : 'every source is current'
                  }
                  to="/sources"
                />
              </>
            )}
          </div>

          <div className="overview-grid">
            <Card
              title="Clusters by provider"
              description={summary ? plural(fleetTotal, 'discovered cluster') : undefined}
              actions={
                <Link className={buttonClass('ghost', 'sm')} to="/clusters">
                  View all
                </Link>
              }
              flush
            >
              {!summary ? (
                <OverviewSkeletonList />
              ) : fleetTotal === 0 ? (
                <EmptyState
                  compact
                  title="No clusters discovered yet"
                  description="Enable a cloud source and run a sync to pull clusters in."
                  action={
                    <Link className={buttonClass('secondary', 'sm')} to="/sources">
                      Open cloud sources
                    </Link>
                  }
                />
              ) : (
                <ul className="provider-bars">
                  {providers
                    .filter((provider) => summary.providerCounts[provider] > 0)
                    .map((provider) => (
                      <li key={provider}>
                        <ProviderLogo provider={provider} className="provider-bars-logo" />
                        <span className="provider-bars-name">
                          {providerLabels[provider]}
                          <small>{providerNames[provider]}</small>
                        </span>
                        <span className="provider-bars-track" aria-hidden="true">
                          <span
                            className={`provider-bars-fill provider-bars-fill--${provider}`}
                            style={{
                              width: `${(summary.providerCounts[provider] / providerMax) * 100}%`,
                            }}
                          />
                        </span>
                        <strong className="provider-bars-count">
                          {summary.providerCounts[provider]}
                        </strong>
                      </li>
                    ))}
                </ul>
              )}
            </Card>

            <Card
              title="Applications by health"
              description={summary ? plural(groupCount, 'application') : undefined}
              actions={
                <Link className={buttonClass('ghost', 'sm')} to="/applications">
                  View all
                </Link>
              }
            >
              {!summary ? (
                <Skeleton height={64} />
              ) : groupCount === 0 ? (
                <EmptyState
                  compact
                  title="No applications onboarded yet"
                  description="Onboard one and its health across clusters shows up here."
                  action={
                    <Link className={buttonClass('secondary', 'sm')} to="/applications/new">
                      Onboard application
                    </Link>
                  }
                />
              ) : (
                <div className="health-distribution">
                  <div className="health-bar" aria-hidden="true">
                    {healthOrder.map((status) => {
                      const count = summary.statusCounts.get(status) ?? 0
                      return count > 0 ? (
                        <span
                          key={status}
                          className={`health-bar-segment health-bar-segment--${status}`}
                          style={{ flexGrow: count }}
                        />
                      ) : null
                    })}
                  </div>
                  <ul className="health-legend">
                    {healthOrder.map((status) => (
                      <li key={status}>
                        <Link to={`/applications?status=${status}`}>
                          <span
                            className={`health-swatch health-bar-segment--${status}`}
                            aria-hidden="true"
                          />
                          <span className="health-legend-label">{status}</span>
                          <strong>{summary.statusCounts.get(status) ?? 0}</strong>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Card>

            <Card title="Needs attention" flush>
              {!summary ? (
                <OverviewSkeletonList />
              ) : summary.attentionApps.length === 0 && summary.attentionSources.length === 0 ? (
                <EmptyState
                  compact
                  title="Nothing needs attention"
                  description="Every application has settled and every source synced recently."
                />
              ) : (
                <ul className="overview-list">
                  {summary.attentionApps.slice(0, 6).map((group) => (
                    <li key={`app-${group.key}`}>
                      <Link
                        className="overview-list-link"
                        to={`/applications/${group.applicationId}`}
                      >
                        <span className="overview-list-copy">
                          <strong>{group.name}</strong>
                          <small>
                            {group.environments.join(' · ') || 'no environment'} ·{' '}
                            {plural(group.targets.length, 'target')}
                          </small>
                        </span>
                        <StatusBadge status={group.status} />
                      </Link>
                    </li>
                  ))}
                  {summary.attentionSources.map((source) => (
                    <li key={`source-${source.id}`}>
                      <Link className="overview-list-link" to="/sources">
                        <ProviderLogo provider={source.provider} className="overview-list-logo" />
                        <span className="overview-list-copy">
                          <strong>{source.name}</strong>
                          <small>
                            {source.lastSyncError ||
                              `Last synced ${relativeTime(source.lastSyncAt).toLowerCase()}`}
                          </small>
                        </span>
                        <StatusBadge
                          status={source.lastSyncStatus === 'failed' ? 'failed' : 'stale'}
                        />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card
              title="Recent sync runs"
              flush
              actions={
                <Link className={buttonClass('ghost', 'sm')} to="/sources">
                  Cloud sources
                </Link>
              }
            >
              {!summary ? (
                <OverviewSkeletonList />
              ) : (data?.runs ?? []).length === 0 ? (
                <EmptyState
                  compact
                  title="No sync activity yet"
                  description="Discovery runs appear here as sources sync."
                />
              ) : (
                <ul className="overview-list">
                  {(data?.runs ?? []).slice(0, 6).map((run) => (
                    <li key={run.id} className="overview-list-row">
                      <span className={`sync-dot sync-dot--${run.status}`} aria-hidden="true" />
                      <span className="overview-list-copy">
                        <strong>{run.sourceName}</strong>
                        <small>
                          {run.trigger} · {plural(run.discoveredCount, 'cluster')} discovered
                          {run.error ? ` · ${run.error}` : ''}
                        </small>
                      </span>
                      <time dateTime={run.queuedAt} className="overview-list-time">
                        {relativeTime(run.queuedAt)}
                      </time>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
    </section>
  )
}

function OverviewSkeletonList() {
  return (
    <div className="overview-skeleton" aria-hidden="true">
      {Array.from({ length: 4 }, (_, index) => (
        <Skeleton key={index} height={14} width={`${80 - index * 10}%`} />
      ))}
    </div>
  )
}
