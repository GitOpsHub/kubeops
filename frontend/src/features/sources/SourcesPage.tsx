import { useCallback, useEffect, useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { errorMessage } from '../../api/client'
import {
  getSources,
  getSyncRuns,
  maxSyncRuns,
  queueSourceSync,
  type CloudSource,
} from '../../api/inventory'
import { ProviderLogo } from '../../components/BrandIcons'
import { SyncIcon } from '../../components/icons'
import { Banner } from '../../components/ui/Banner'
import { StatusBadge, Tag } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { LoadingState } from '../../components/ui/LoadingState'
import { PageHeader } from '../../components/ui/PageHeader'
import { RefreshIndicator } from '../../components/ui/RefreshIndicator'
import { useToast } from '../../components/ui/toast-context'
import { useNow } from '../../hooks/useNow'
import { usePolledResource } from '../../hooks/usePolledResource'
import { useUrlState } from '../../hooks/useUrlState'
import type { AppShellContext } from '../../lib/app-shell'
import { plural, relativeTime } from '../../lib/format'
import { providerLabels, providerNames } from '../../lib/providers'
import { RunHistory } from './RunHistory'
import { SyncRunsTable } from './SyncRunsTable'
import { formatDuration, runDurationMs, runsBySource, sourceStanding } from './run-format'
import './sources.css'

const pollIntervalMs = 15_000
const historySlots = 20
const runsPageSize = 50

export function SourcesPage() {
  const { refreshSyncStatus } = useOutletContext<AppShellContext>()
  const [syncing, setSyncing] = useState('')
  const toast = useToast()
  const now = useNow()
  // `?source=` is how the overview's attention links point at one source.
  const [url, setUrl] = useUrlState({ source: '' })
  const sourceFilter = url.source
  const [limit, setLimit] = useState(runsPageSize)
  const [limitFor, setLimitFor] = useState(sourceFilter)
  if (limitFor !== sourceFilter) {
    setLimitFor(sourceFilter)
    setLimit(runsPageSize)
  }

  // The strips read one wide window of runs across every source; the table
  // asks for exactly the slice it shows, so a filter or "Load more" never
  // refetches the sources.
  const loadSources = useCallback(async (signal: AbortSignal) => {
    const [sources, history] = await Promise.all([
      getSources(signal),
      getSyncRuns({ limit: maxSyncRuns }, signal),
    ])
    return { sources, history }
  }, [])
  const inventory = usePolledResource(loadSources, { intervalMs: pollIntervalMs })
  const loadRuns = useCallback(
    (signal: AbortSignal) => getSyncRuns({ limit, sourceId: sourceFilter }, signal),
    [limit, sourceFilter],
  )
  const runs = usePolledResource(loadRuns, { intervalMs: pollIntervalMs })

  const sources = useMemo(() => inventory.data?.sources ?? [], [inventory.data])
  const history = useMemo(
    () => runsBySource(inventory.data?.history ?? [], historySlots),
    [inventory.data],
  )
  const runItems = runs.data ?? []

  useEffect(() => {
    if (!sourceFilter || inventory.loading) return
    document.getElementById(`source-${sourceFilter}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [sourceFilter, inventory.loading])

  async function syncSource(source: CloudSource) {
    setSyncing(source.id)
    try {
      await queueSourceSync(source.id)
      toast.success(`Sync queued for ${source.name}.`)
      await Promise.all([inventory.reload(), runs.reload(), refreshSyncStatus()])
    } catch (error) {
      toast.error('Sync could not be started', {
        description: errorMessage(error, 'The request was rejected.'),
      })
    } finally {
      setSyncing('')
    }
  }

  function showRuns(sourceId: string) {
    setUrl({ source: sourceId })
    document.getElementById('sync-runs')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }

  const enabledCount = sources.filter((source) => source.enabled).length

  return (
    <section className="page" aria-labelledby="sources-heading">
      <PageHeader
        id="sources-heading"
        title="Cloud sources"
        description="The accounts, projects, and subscriptions KubeOps discovers clusters in."
        meta={
          <RefreshIndicator
            lastUpdated={inventory.lastUpdated}
            refreshing={inventory.refreshing || runs.refreshing}
            failed={Boolean(inventory.error)}
          />
        }
      />

      {inventory.error && (
        <Banner
          tone="error"
          title="Sources could not be loaded"
          onRetry={() => void inventory.reload()}
        >
          {inventory.error.message}
        </Banner>
      )}

      {inventory.loading ? (
        <div className="panel">
          <LoadingState label="Loading cloud sources…" shape="cards" rows={3} />
        </div>
      ) : sources.length === 0 ? (
        <div className="panel">
          <EmptyState
            title={
              inventory.error ? 'Cloud sources are unavailable' : 'No cloud sources configured'
            }
            description={
              <>
                Add a row to the <code>cloud_sources</code> table, or a source to{' '}
                <code>config/cloud-sources.yaml</code>, to begin discovery.
              </>
            }
          />
        </div>
      ) : (
        <>
          <p className="source-summary">
            {plural(sources.length, 'source')} · {enabledCount} enabled
          </p>
          <ul className="source-grid">
            {sources.map((source) => {
              const sourceRuns = history.get(source.id) ?? []
              const run = sourceRuns[0]
              const error =
                source.lastSyncError || (run?.status === 'failed' ? (run.error ?? '') : '')
              const duration = run?.completedAt ? formatDuration(runDurationMs(run, now)) : ''
              return (
                <li
                  className={`source-card${sourceFilter === source.id ? ' is-selected' : ''}${
                    source.enabled ? '' : ' is-disabled'
                  }`}
                  key={source.id}
                  id={`source-${source.id}`}
                  aria-label={source.name}
                >
                  <div className="source-card-head">
                    <span className="source-logo" aria-hidden="true">
                      <ProviderLogo provider={source.provider} />
                    </span>
                    <div className="source-identity">
                      <strong className="truncate" title={source.name}>
                        {source.name}
                      </strong>
                      <span className="source-meta" title={source.scopeId}>
                        {providerNames[source.provider]} ({providerLabels[source.provider]}) ·{' '}
                        <span className="mono">{source.scopeId}</span>
                      </span>
                    </div>
                    <StatusBadge domain="run" status={sourceStanding(source, now)} />
                  </div>

                  <div className="source-regions">
                    {source.regions.map((region) => (
                      <Tag key={region} mono>
                        {region === '*' || region === '-' ? 'all regions' : region}
                      </Tag>
                    ))}
                  </div>

                  <div className="source-stats">
                    <div className="source-count">
                      <strong>{source.clusterCount}</strong>
                      <span>{source.clusterCount === 1 ? 'cluster' : 'clusters'}</span>
                    </div>
                    <p className="source-sync">
                      {source.lastSyncAt
                        ? `Synced ${relativeTime(source.lastSyncAt)}`
                        : 'Never synced'}
                      {run &&
                        ` · last run ${run.trigger}, ${plural(run.discoveredCount, 'cluster')}`}
                      {duration && ` in ${duration}`}
                    </p>
                  </div>

                  <div className="source-history">
                    <div className="source-history-caption" aria-hidden="true">
                      <span>Last {historySlots} runs</span>
                      <span>now</span>
                    </div>
                    <RunHistory
                      runs={sourceRuns}
                      slots={historySlots}
                      label={`Recent runs for ${source.name}`}
                    />
                  </div>

                  {error && (
                    <p className="source-error" role="note">
                      {error}
                    </p>
                  )}

                  <div className="source-card-foot">
                    <button
                      type="button"
                      className="link-button"
                      aria-pressed={sourceFilter === source.id}
                      onClick={() => showRuns(sourceFilter === source.id ? '' : source.id)}
                    >
                      View runs
                    </button>
                    <Button
                      size="sm"
                      icon={<SyncIcon aria-hidden="true" />}
                      onClick={() => void syncSource(source)}
                      disabled={!source.enabled || syncing === source.id}
                    >
                      {syncing === source.id ? 'Syncing…' : 'Sync now'}
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        </>
      )}

      <SyncRunsTable
        runs={runItems}
        loading={runs.loading}
        error={runs.error}
        onRetry={() => void runs.reload()}
        sources={sources}
        sourceFilter={sourceFilter}
        onSourceFilterChange={(sourceId) => setUrl({ source: sourceId })}
        onLoadMore={
          runItems.length >= limit && limit < maxSyncRuns
            ? () => setLimit((current) => Math.min(maxSyncRuns, current + runsPageSize))
            : null
        }
        loadingMore={runs.refreshing}
      />
    </section>
  )
}
