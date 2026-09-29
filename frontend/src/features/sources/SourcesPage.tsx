import { useCallback, useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { errorMessage } from '../../api/client'
import {
  getSources,
  getSyncRuns,
  queueSourceSync,
  type CloudSource,
  type SyncRun,
} from '../../api/inventory'
import { ProviderLogo } from '../../components/BrandIcons'
import { Banner } from '../../components/ui/Banner'
import { StatusBadge, Tag } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageHeader } from '../../components/ui/PageHeader'
import { RefreshIndicator } from '../../components/ui/RefreshIndicator'
import { SkeletonRows } from '../../components/ui/Skeleton'
import { useReloadAfterAutoSync, useSyncInterval } from '../../hooks/useAutoSync'
import { usePolledResource } from '../../hooks/usePolledResource'
import type { AppShellContext } from '../../lib/app-shell'
import { isOlderThan, plural, relativeTime } from '../../lib/format'
import {
  describeInterval,
  syncTriggerLabel,
  providerLabels,
  providerNames,
  staleAfterMs,
} from '../../lib/providers'
import './sources.css'

const pollIntervalMs = 15_000

/** A succeeded sync that is too old to trust reads as stale, not healthy. */
function displayedStatus(source: CloudSource, staleMs: number) {
  if (!source.enabled) return 'disabled'
  if (source.lastSyncStatus === 'succeeded' && isOlderThan(source.lastSyncAt, staleMs)) {
    return 'stale'
  }
  return source.lastSyncStatus || 'unknown'
}

function lastSyncLabel(source: CloudSource) {
  if (!source.lastSyncAt) return 'Never synced'
  const when = relativeTime(source.lastSyncAt)
  return source.lastSyncStatus === 'failed' ? `Failed ${when}` : `Synced ${when}`
}

/**
 * Provider errors run to several hundred characters of SDK detail. The first
 * clause is usually enough to know what broke, so that is what shows; the rest
 * is one click away.
 */
function SyncError({ message }: { message: string }) {
  const summary = message.split(/:\s/)[0]
  if (summary.length === message.length) {
    return (
      <p className="source-error" role="note">
        {message}
      </p>
    )
  }
  return (
    <details className="source-error">
      <summary>{summary}</summary>
      <p>{message}</p>
    </details>
  )
}

export function SourcesPage() {
  const { refreshSyncStatus } = useOutletContext<AppShellContext>()
  const [syncing, setSyncing] = useState('')
  const [actionError, setActionError] = useState('')

  const load = useCallback(async (signal: AbortSignal) => {
    const [sources, runs] = await Promise.all([getSources(signal), getSyncRuns(signal)])
    return { sources, runs }
  }, [])
  const inventory = usePolledResource(load, { intervalMs: pollIntervalMs })
  useReloadAfterAutoSync(inventory.reload)
  const syncIntervalMs = useSyncInterval()
  const staleMs = staleAfterMs(syncIntervalMs)
  const sources = inventory.data?.sources ?? []
  const runs = useMemo(() => inventory.data?.runs ?? [], [inventory.data])

  // Runs arrive newest first, so the first one seen per source is its latest.
  const latestRunBySource = useMemo(() => {
    const latest = new Map<string, SyncRun>()
    for (const run of runs) if (!latest.has(run.sourceId)) latest.set(run.sourceId, run)
    return latest
  }, [runs])

  async function syncSource(source: CloudSource) {
    setSyncing(source.id)
    setActionError('')
    try {
      await queueSourceSync(source.id)
      await Promise.all([inventory.reload(), refreshSyncStatus()])
    } catch (error) {
      setActionError(errorMessage(error, 'Sync could not be started'))
    } finally {
      setSyncing('')
    }
  }

  return (
    <section className="page" aria-labelledby="sources-heading">
      <PageHeader
        id="sources-heading"
        title="Cloud sources"
        description={
          <>
            The accounts, projects, and subscriptions KubeOps discovers clusters in. Each one
            syncs automatically every {describeInterval(syncIntervalMs)}.
          </>
        }
        meta={
          <RefreshIndicator
            lastUpdated={inventory.lastUpdated}
            refreshing={inventory.refreshing}
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
      {actionError && (
        <Banner tone="error" title="Sync could not be started" onDismiss={() => setActionError('')}>
          {actionError}
        </Banner>
      )}

      <div className="panel">
        {inventory.loading ? (
          <div role="status">
            <span className="sr-only">Loading cloud sources…</span>
            <SkeletonRows rows={4} columns={4} />
          </div>
        ) : sources.length === 0 ? (
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
        ) : (
          <ul className="source-list">
            {sources.map((source) => {
              const run = latestRunBySource.get(source.id)
              const error = source.lastSyncError || (run?.status === 'failed' ? run.error : '')
              return (
                <li className="source-row" key={source.id} aria-label={source.name}>
                  <span className="source-logo" aria-hidden="true">
                    <ProviderLogo provider={source.provider} />
                  </span>
                  <div className="source-identity">
                    <strong>{source.name}</strong>
                    <span className="source-meta">
                      {providerNames[source.provider]} ({providerLabels[source.provider]}) ·{' '}
                      <span className="mono">{source.scopeId}</span>
                    </span>
                    <span className="source-regions">
                      {source.regions.map((region) => (
                        <Tag key={region} mono>
                          {region === '*' || region === '-' ? 'all regions' : region}
                        </Tag>
                      ))}
                    </span>
                  </div>
                  <div className="source-count">
                    <strong>{source.clusterCount}</strong>
                    <span>{source.clusterCount === 1 ? 'cluster' : 'clusters'}</span>
                  </div>
                  <div className="source-sync">
                    <StatusBadge status={displayedStatus(source, staleMs)} />
                    <span>
                      {lastSyncLabel(source)}
                      {run?.status === 'succeeded' &&
                        ` · ${plural(run.discoveredCount, 'cluster')} found`}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void syncSource(source)}
                    disabled={!source.enabled}
                    loading={syncing === source.id}
                  >
                    {syncing === source.id ? 'Syncing…' : 'Sync now'}
                  </Button>
                  {error && <SyncError message={error} />}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <Card
        title="Recent sync runs"
        description="Discovery runs across every source, newest first."
        flush
      >
        {inventory.loading ? (
          <SkeletonRows rows={3} columns={4} />
        ) : runs.length === 0 ? (
          <EmptyState
            compact
            title="No sync activity yet"
            description="Runs appear here as sources sync."
          />
        ) : (
          <ul className="run-list">
            {runs.map((run) => (
              <li key={run.id}>
                <span className={`sync-dot sync-dot--${run.status}`} aria-hidden="true" />
                <span className="run-copy">
                  <strong>{run.sourceName}</strong>
                  <small>
                    {syncTriggerLabel(run.trigger)} ·{' '}
                    {run.status === 'failed'
                      ? (run.error ?? 'failed')
                      : `${run.discoveredCount} discovered · ${run.changedCount} changed · ${run.removedCount} removed`}
                  </small>
                </span>
                <StatusBadge status={run.status} />
                <time dateTime={run.queuedAt}>{relativeTime(run.queuedAt)}</time>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  )
}
