import type { CloudSource, SyncRun } from '../../api/inventory'
import { ProviderLogo } from '../../components/BrandIcons'
import { StatusBadge, Tag } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { DataTable, type Column } from '../../components/ui/DataTable'
import { EmptyState } from '../../components/ui/EmptyState'
import { ErrorState } from '../../components/ui/ErrorState'
import { FilterMenu } from '../../components/ui/FilterMenu'
import { LoadingState } from '../../components/ui/LoadingState'
import { Timestamp } from '../../components/ui/Timestamp'
import { useNow } from '../../hooks/useNow'
import { plural } from '../../lib/format'
import { formatDuration, runDurationMs } from './run-format'

type Props = {
  runs: SyncRun[]
  loading: boolean
  error: Error | null
  onRetry: () => void
  sources: CloudSource[]
  sourceFilter: string
  onSourceFilterChange: (sourceId: string) => void
  /** Null when every run the API will return is already shown. */
  onLoadMore: (() => void) | null
  loadingMore: boolean
}

/** Every discovery run, newest first, with what it found and how long it took. */
export function SyncRunsTable({
  runs,
  loading,
  error,
  onRetry,
  sources,
  sourceFilter,
  onSourceFilterChange,
  onLoadMore,
  loadingMore,
}: Props) {
  const now = useNow()
  const filteredName = sources.find((source) => source.id === sourceFilter)?.name

  const columns: Column<SyncRun>[] = [
    {
      id: 'source',
      header: 'Source',
      cell: (run) => (
        <span className="run-source">
          <ProviderLogo provider={run.provider} className="run-source-logo" />
          <span className="truncate" title={run.sourceName}>
            {run.sourceName}
          </span>
        </span>
      ),
    },
    { id: 'trigger', header: 'Trigger', cell: (run) => <Tag>{run.trigger}</Tag> },
    {
      id: 'status',
      header: 'Status',
      cell: (run) => (
        <span className="cell-stack run-status">
          <StatusBadge domain="run" status={run.status} />
          {run.error && (
            <small className="run-error truncate" title={run.error}>
              {run.error}
            </small>
          )}
        </span>
      ),
    },
    {
      id: 'discovered',
      header: 'Discovered',
      align: 'end',
      className: 'cell-numeric',
      cell: (run) => run.discoveredCount,
    },
    {
      id: 'changed',
      header: 'Changed',
      align: 'end',
      className: 'cell-numeric',
      cell: (run) => (run.changedCount ? run.changedCount : <span className="cell-muted">0</span>),
    },
    {
      id: 'removed',
      header: 'Removed',
      align: 'end',
      className: 'cell-numeric',
      cell: (run) => (run.removedCount ? run.removedCount : <span className="cell-muted">0</span>),
    },
    {
      id: 'duration',
      header: 'Duration',
      align: 'end',
      className: 'cell-numeric',
      cell: (run) => (
        <span className={run.completedAt ? undefined : 'cell-muted'}>
          {formatDuration(runDurationMs(run, now))}
        </span>
      ),
    },
    {
      id: 'started',
      header: 'Started',
      cell: (run) => <Timestamp value={run.startedAt ?? run.queuedAt} className="cell-muted" />,
    },
  ]

  return (
    <Card
      id="sync-runs"
      title="Recent sync runs"
      description={
        filteredName
          ? `Discovery runs for ${filteredName}, newest first.`
          : 'Discovery runs across every source, newest first.'
      }
      actions={
        <FilterMenu
          label="Source"
          allLabel="All sources"
          align="end"
          value={sourceFilter}
          options={sources.map((source) => ({
            value: source.id,
            label: source.name,
            icon: <ProviderLogo provider={source.provider} />,
          }))}
          onChange={onSourceFilterChange}
        />
      }
      flush
      className="sync-runs-card"
    >
      {loading ? (
        <LoadingState label="Loading sync runs…" rows={4} columns={6} />
      ) : error && runs.length === 0 ? (
        <ErrorState
          compact
          title="Sync runs could not be loaded"
          message={error.message}
          onRetry={onRetry}
        />
      ) : runs.length === 0 ? (
        <EmptyState
          compact
          title={sourceFilter ? 'No runs for this source yet' : 'No sync activity yet'}
          description="Runs appear here as sources sync."
          action={
            sourceFilter ? (
              <Button size="sm" onClick={() => onSourceFilterChange('')}>
                Show every source
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <DataTable
            label="Sync runs"
            columns={columns}
            rows={runs}
            rowKey={(run) => run.id}
            rowClassName={(run) => (run.status === 'failed' ? 'is-failed' : '')}
          />
          <div className="table-footer">
            <span>Showing {plural(runs.length, 'run')}</span>
            {onLoadMore && (
              <Button size="sm" loading={loadingMore} onClick={onLoadMore}>
                Load more
              </Button>
            )}
          </div>
        </>
      )}
    </Card>
  )
}
