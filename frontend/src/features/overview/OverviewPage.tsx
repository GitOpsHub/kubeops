import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { Provider, SyncRun } from '../../api/inventory'
import { getOverview, type AttentionItem, type Overview } from '../../api/overview'
import { ProviderLogo } from '../../components/BrandIcons'
import { Donut, type DonutSegment } from '../../components/charts/Donut'
import { Sparkline } from '../../components/charts/Sparkline'
import { StackedBar } from '../../components/charts/StackedBar'
import { TimeSeries } from '../../components/charts/TimeSeries'
import { CloudIcon, ErrorIcon, PlusIcon, SuccessIcon, WarningIcon } from '../../components/icons'
import { StatusBadge, Tag } from '../../components/ui/Badge'
import { Banner } from '../../components/ui/Banner'
import { buttonClass } from '../../components/ui/button-class'
import { Card } from '../../components/ui/Card'
import { DataTable, type Column } from '../../components/ui/DataTable'
import { EmptyState } from '../../components/ui/EmptyState'
import { ErrorState } from '../../components/ui/ErrorState'
import { PageHeader } from '../../components/ui/PageHeader'
import { RefreshIndicator } from '../../components/ui/RefreshIndicator'
import { Skeleton } from '../../components/ui/Skeleton'
import { StatCard } from '../../components/ui/StatCard'
import { Timestamp } from '../../components/ui/Timestamp'
import { usePolledResource } from '../../hooks/usePolledResource'
import { plural } from '../../lib/format'
import { providerLabels, providerNames } from '../../lib/providers'
import { statusMeta, type StatusDomain } from '../../lib/status'
import {
  applicationStatusOrder,
  dailySuccessRates,
  formatDuration,
  formatShare,
  healthyTargetShare,
  isEmptyFleet,
  providerCounts,
  runDurationMs,
  seriesDelta,
  statusSegments,
  syncSuccessRate,
  targetHealthOrder,
  targetSyncOrder,
} from './overview-metrics'
import './overview.css'

const pollIntervalMs = 30_000
/** Attention items shown before "View all"; the worst come first. */
const attentionPreview = 6

export function OverviewPage() {
  const overview = usePolledResource(getOverview, { intervalMs: pollIntervalMs })
  const data = overview.data

  let content
  if (!data && overview.error) {
    content = (
      <ErrorState
        title="Overview could not be loaded"
        message={overview.error.message}
        onRetry={() => void overview.reload()}
      />
    )
  } else if (data && isEmptyFleet(data)) {
    content = <EmptyFleet />
  } else {
    content = <Dashboard data={data} />
  }

  return (
    <section className="page overview" aria-labelledby="overview-heading">
      <PageHeader
        id="overview-heading"
        title="Overview"
        description="Fleet health across every connected cloud source and Argo CD target."
        actions={
          <Link className={buttonClass('primary')} to="/applications/new">
            <PlusIcon aria-hidden="true" />
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
      {data && overview.error && (
        <Banner
          tone="error"
          title="Overview could not be refreshed"
          onRetry={() => void overview.reload()}
        >
          {overview.error.message} Showing the last figures that loaded.
        </Banner>
      )}
      {content}
    </section>
  )
}

/**
 * Loading and loaded share one tree, so the cards keep their place (and their
 * DOM) when the data arrives and only their bodies swap from skeleton to chart.
 */
function Dashboard({ data }: { data: Overview | undefined }) {
  return (
    <>
      {!data && (
        <p className="sr-only" role="status">
          Loading overview…
        </p>
      )}
      <KpiRow data={data} />
      <div className="overview-grid">
        <ProvidersCard data={data} />
        <ApplicationsCard data={data} />
      </div>
      <SyncActivityCard data={data} />
      <AttentionCard items={data?.attention} />
      <RecentRunsCard runs={data?.syncRuns.recent} />
    </>
  )
}

function KpiRow({ data }: { data: Overview | undefined }) {
  if (!data) {
    return (
      <div className="overview-kpis" aria-hidden="true">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} height={132} radius="var(--radius-lg)" />
        ))}
      </div>
    )
  }

  const fleet = data.clusters.series14d.map((day) => day.total)
  const delta = seriesDelta(fleet)
  const apps = data.applications
  const statuses = statusSegments('lifecycle', apps.byStatus, applicationStatusOrder)
  const settled = statuses.find((segment) => segment.id === 'healthy')?.value ?? 0
  const troubled = statuses
    .filter((segment) => segment.id === 'failed' || segment.id === 'partial')
    .reduce((sum, segment) => sum + segment.value, 0)
  const health = healthyTargetShare(apps.targets)
  const sync = syncSuccessRate(data.syncRuns.last24h)

  return (
    <div className="overview-kpis">
      <StatCard
        label="Clusters"
        value={data.clusters.total}
        hint={
          fleet.length < 2
            ? plural(Object.keys(data.clusters.byProvider).length, 'provider')
            : delta === 0
              ? 'No change in 14 days'
              : `${delta > 0 ? '+' : '−'}${Math.abs(delta)} in 14 days`
        }
        icon={<CloudIcon />}
        to="/clusters"
      >
        {fleet.length > 1 && (
          <Sparkline values={fleet} label="Fleet size, last 14 days" tone="chart-1" />
        )}
      </StatCard>
      <StatCard
        label="Applications"
        value={apps.total}
        hint={
          apps.total === 0
            ? 'Nothing onboarded yet'
            : `${settled} healthy · ${troubled} need attention`
        }
        to="/applications"
      >
        {apps.total > 0 && (
          <StackedBar segments={statuses} label="Releases by status" size="sm" decorative />
        )}
      </StatCard>
      <StatCard
        label="Healthy targets"
        value={formatShare(health.percent)}
        tone={health.percent !== null && health.percent < 100 ? 'warn' : undefined}
        hint={
          health.total === 0
            ? 'No deployment targets yet'
            : `${health.healthy} of ${plural(health.total, 'target')} healthy`
        }
        to="/applications"
      >
        {health.total > 0 && (
          <StackedBar
            segments={statusSegments('health', apps.targets.byHealth, targetHealthOrder)}
            label="Deployment targets by health"
            size="sm"
            decorative
          />
        )}
      </StatCard>
      <StatCard
        label="Sync success · 24h"
        value={formatShare(sync.percent)}
        tone={sync.failed > 0 ? 'warn' : undefined}
        hint={
          sync.completed === 0
            ? sync.running > 0
              ? `${sync.running} running now`
              : 'No runs completed in 24h'
            : `${sync.succeeded} of ${plural(sync.completed, 'run')}${sync.running ? ` · ${sync.running} running` : ''}`
        }
        to="/sources"
      >
        {data.syncRuns.series14d.length > 1 && (
          <Sparkline
            values={dailySuccessRates(data.syncRuns.series14d)}
            label="Daily sync success rate, last 14 days"
            tone="chart-1"
            formatValue={(value) => formatShare(value)}
          />
        )}
      </StatCard>
    </div>
  )
}

function ProvidersCard({ data }: { data: Overview | undefined }) {
  const total = data?.clusters.total ?? 0
  const counts = providerCounts(data?.clusters.byProvider)
  const segments: DonutSegment[] = counts.known.map(({ provider, value, color }) => ({
    id: provider,
    label: providerLabels[provider as Provider],
    value,
    color,
    icon: <ProviderLogo provider={provider as Provider} />,
    href: `/clusters?provider=${provider}`,
  }))
  if (counts.other > 0) {
    segments.push({ id: 'other', label: 'Other', value: counts.other, color: counts.otherColor })
  }

  return (
    <Card
      title="Clusters by provider"
      description={data ? plural(total, 'discovered cluster') : undefined}
      actions={
        <Link className={buttonClass('ghost', 'sm')} to="/clusters">
          View all
        </Link>
      }
    >
      {!data ? (
        <div className="overview-donut-skeleton" aria-hidden="true">
          <Skeleton width={132} height={132} radius="50%" />
          <div className="overview-skeleton">
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton key={index} height={14} width={`${90 - index * 15}%`} />
            ))}
          </div>
        </div>
      ) : total === 0 ? (
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
        <Donut
          segments={segments}
          label={`Clusters by provider: ${segments
            .map((segment) => `${providerTitle(segment.id)} ${segment.value}`)
            .join(', ')}`}
          center={{ value: total, label: total === 1 ? 'cluster' : 'clusters' }}
        />
      )}
    </Card>
  )
}

function providerTitle(id: string) {
  return id in providerNames ? providerLabels[id as Provider] : 'Other'
}

function ApplicationsCard({ data }: { data: Overview | undefined }) {
  const apps = data?.applications
  return (
    <Card
      title="Applications by health"
      description={
        apps
          ? `${plural(apps.total, 'release')} · ${plural(apps.targets.total, 'deployment target')}`
          : undefined
      }
      actions={
        <Link className={buttonClass('ghost', 'sm')} to="/applications">
          View all
        </Link>
      }
    >
      {!apps ? (
        <div className="overview-skeleton overview-skeleton--padded" aria-hidden="true">
          <Skeleton height={10} />
          <Skeleton height={14} width="70%" />
          <Skeleton height={6} />
          <Skeleton height={6} />
        </div>
      ) : apps.total === 0 ? (
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
        <div className="overview-health">
          <StackedBar
            label="Releases by status"
            segments={statusSegments('lifecycle', apps.byStatus, applicationStatusOrder).map(
              (segment) => ({ ...segment, href: `/applications?status=${segment.id}` }),
            )}
          />
          {apps.targets.total > 0 && (
            <div className="overview-health-targets">
              <h3 className="overview-subheading">Deployment targets</h3>
              <StackedBar
                label="Target health"
                size="sm"
                segments={statusSegments('health', apps.targets.byHealth, targetHealthOrder, {
                  includeEmpty: false,
                })}
              />
              <StackedBar
                label="Target sync"
                size="sm"
                segments={statusSegments('sync', apps.targets.bySync, targetSyncOrder, {
                  includeEmpty: false,
                })}
              />
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

function SyncActivityCard({ data }: { data: Overview | undefined }) {
  const days = data?.syncRuns.series14d ?? []
  return (
    <Card
      title="Sync activity"
      description="Cloud source discovery runs over the last 14 days"
      actions={
        <Link className={buttonClass('ghost', 'sm')} to="/sources">
          Cloud sources
        </Link>
      }
    >
      {!data ? (
        <div className="overview-activity" aria-hidden="true">
          <Skeleton height={188} radius="var(--radius-md)" />
          <Skeleton height={188} radius="var(--radius-md)" />
        </div>
      ) : (
        // Counts and durations have different scales, so they get a chart each
        // rather than sharing one plot with two y-axes.
        <div className="overview-activity">
          <div className="overview-activity-chart">
            <h3 className="overview-subheading">Runs per day</h3>
            <TimeSeries
              label="Sync runs per day"
              height={168}
              emptyLabel="No sync runs in the last 14 days"
              series={[
                {
                  id: 'succeeded',
                  label: 'Succeeded',
                  kind: 'bar',
                  tone: 'ok',
                  points: days.map((day) => ({ x: day.date, y: day.succeeded })),
                },
                {
                  id: 'failed',
                  label: 'Failed',
                  kind: 'bar',
                  tone: 'err',
                  points: days.map((day) => ({ x: day.date, y: day.failed })),
                },
              ]}
            />
          </div>
          <div className="overview-activity-chart">
            <h3 className="overview-subheading">Run duration</h3>
            <TimeSeries
              label="Sync run duration per day"
              height={168}
              yFormat={(ms) => (ms === 0 ? '0' : formatDuration(ms))}
              emptyLabel="No completed runs to time yet"
              series={[
                {
                  id: 'p50',
                  label: 'Median (p50)',
                  kind: 'line',
                  tone: 'chart-1',
                  points: days.map((day) => ({ x: day.date, y: day.p50Ms })),
                },
                {
                  id: 'p95',
                  label: 'Slowest 5% (p95)',
                  kind: 'line',
                  tone: 'chart-4',
                  points: days.map((day) => ({ x: day.date, y: day.p95Ms })),
                },
              ]}
            />
          </div>
        </div>
      )}
    </Card>
  )
}

const attentionKinds: Record<AttentionItem['kind'], { label: string; domain: StatusDomain }> = {
  application: { label: 'Application', domain: 'lifecycle' },
  cluster: { label: 'Cluster', domain: 'cluster' },
  source: { label: 'Source', domain: 'run' },
}

function AttentionCard({ items }: { items: AttentionItem[] | undefined }) {
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? items : items?.slice(0, attentionPreview)
  const hidden = (items?.length ?? 0) - attentionPreview

  return (
    <Card
      title="Needs attention"
      description={
        items && items.length > 0 ? `${plural(items.length, 'item')}, worst first` : undefined
      }
      flush
    >
      {!items ? (
        <div className="overview-skeleton" aria-hidden="true">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} height={14} width={`${80 - index * 12}%`} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          compact
          icon={<SuccessIcon />}
          title="Nothing needs attention"
          description="Every application has settled, every cluster is healthy, and every source synced recently."
        />
      ) : (
        <>
          <ul className="attention-list">
            {visible?.map((item) => {
              const kind = attentionKinds[item.kind] ?? attentionKinds.application
              const meta = statusMeta(kind.domain, item.status)
              return (
                <li key={`${item.kind}-${item.id}`}>
                  <Link className="attention-item" to={item.href}>
                    <span className="attention-icon" data-tone={meta.tone} aria-hidden="true">
                      {meta.tone === 'err' ? <ErrorIcon /> : <WarningIcon />}
                    </span>
                    <span className="attention-copy">
                      <strong>{item.name}</strong>
                      {item.message && <small>{item.message}</small>}
                    </span>
                    <Tag>{kind.label}</Tag>
                    <StatusBadge domain={kind.domain} status={item.status} />
                  </Link>
                </li>
              )
            })}
          </ul>
          {hidden > 0 && (
            <div className="attention-footer">
              <button
                type="button"
                className={buttonClass('ghost', 'sm')}
                aria-expanded={expanded}
                onClick={() => setExpanded((current) => !current)}
              >
                {expanded ? 'Show fewer' : `View all ${items.length}`}
              </button>
            </div>
          )}
        </>
      )}
    </Card>
  )
}

const runColumns: Column<SyncRun>[] = [
  {
    id: 'source',
    header: 'Source',
    cell: (run) => (
      <span className="run-source">
        <ProviderLogo provider={run.provider} className="run-source-logo" />
        <span className="run-source-copy">
          <strong>{run.sourceName}</strong>
          {run.error && <small title={run.error}>{run.error}</small>}
        </span>
      </span>
    ),
  },
  { id: 'trigger', header: 'Trigger', cell: (run) => <Tag>{run.trigger}</Tag> },
  {
    id: 'status',
    header: 'Status',
    cell: (run) => <StatusBadge domain="run" status={run.status} />,
  },
  {
    id: 'discovered',
    header: 'Discovered',
    align: 'end',
    className: 'is-numeric',
    cell: (run) => run.discoveredCount,
  },
  {
    id: 'changed',
    header: 'Changed',
    align: 'end',
    className: 'is-numeric',
    cell: (run) => run.changedCount,
  },
  {
    id: 'removed',
    header: 'Removed',
    align: 'end',
    className: 'is-numeric',
    cell: (run) => run.removedCount,
  },
  {
    id: 'duration',
    header: 'Duration',
    align: 'end',
    className: 'is-numeric',
    cell: (run) => {
      const ms = runDurationMs(run)
      if (ms !== null) return formatDuration(ms)
      return run.status === 'running' || run.status === 'queued' ? 'In progress' : '—'
    },
  },
  {
    id: 'when',
    header: 'Started',
    align: 'end',
    cell: (run) => <Timestamp value={run.startedAt ?? run.queuedAt} />,
  },
]

function RecentRunsCard({ runs }: { runs: SyncRun[] | undefined }) {
  return (
    <Card
      title="Recent sync runs"
      flush
      actions={
        <Link className={buttonClass('ghost', 'sm')} to="/sources">
          Cloud sources
        </Link>
      }
    >
      {!runs ? (
        <div className="overview-skeleton" aria-hidden="true">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} height={14} width={`${85 - index * 10}%`} />
          ))}
        </div>
      ) : runs.length === 0 ? (
        <EmptyState
          compact
          title="No sync activity yet"
          description="Discovery runs appear here as sources sync."
        />
      ) : (
        <DataTable
          label="Recent sync runs"
          columns={runColumns}
          rows={runs}
          rowKey={(run) => run.id}
        />
      )}
    </Card>
  )
}

function EmptyFleet() {
  return (
    <div className="overview-empty">
      <EmptyState
        icon={<CloudIcon />}
        title="Connect a cloud source to get started"
        description={
          <>
            KubeOps discovers clusters rather than registering them. Add a source to{' '}
            <code>config/cloud-sources.yaml</code> or the <code>cloud_sources</code> table, then run
            a sync. Clusters, applications, and sync activity appear here as they arrive.
          </>
        }
        action={
          <>
            <Link className={buttonClass('primary', 'sm')} to="/sources">
              Open cloud sources
            </Link>
            <Link className={buttonClass('secondary', 'sm')} to="/applications/new">
              Onboard application
            </Link>
          </>
        }
      />
    </div>
  )
}
