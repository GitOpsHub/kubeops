import { useNavigate } from 'react-router-dom'
import type { SyncRun } from '../api/inventory'
import { ChevronDownIcon, CloudIcon } from '../components/icons'
import { Button } from '../components/ui/Button'
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '../components/ui/Menu'
import { StatusDot } from '../components/ui/StatusDot'
import { useNow } from '../hooks/useNow'
import { isRunInFlight, syncRunLabel } from '../lib/app-shell'
import { relativeTime } from '../lib/format'
import { statusMeta } from '../lib/status'

const recentRunCount = 5

type Props = {
  runs: SyncRun[]
  unavailable: boolean
}

function headline(run: SyncRun | null, unavailable: boolean, now: number) {
  if (!run) return unavailable ? 'Sync unavailable' : 'No sync yet'
  if (isRunInFlight(run)) return syncRunLabel(run)
  return `${syncRunLabel(run)} ${relativeTime(run.completedAt ?? run.queuedAt, now)}`
}

/**
 * The header's view of discovery: the latest run at a glance, and the last
 * few runs one click away. Each run opens its source, where it can be synced
 * again; the shell never queues a sync on its own.
 */
export function SyncStatusMenu({ runs, unavailable }: Props) {
  const navigate = useNavigate()
  const now = useNow()
  const latest = runs[0] ?? null
  const text = headline(latest, unavailable, now)

  return (
    <Menu
      className="sync-menu"
      trigger={
        <Button
          variant="ghost"
          size="sm"
          className="sync-menu-trigger"
          aria-label={`Sync status: ${text}`}
        >
          <StatusDot domain="run" status={unavailable ? null : latest?.status} size="sm" />
          <span className="sync-menu-trigger-label num">{text}</span>
          <ChevronDownIcon className="sync-menu-chevron" aria-hidden="true" />
        </Button>
      }
    >
      <MenuLabel>Recent sync runs</MenuLabel>
      {runs.length === 0 && (
        <p className="sync-menu-empty">
          {unavailable ? 'Sync activity could not be loaded.' : 'No source has synced yet.'}
        </p>
      )}
      {runs.slice(0, recentRunCount).map((run) => (
        <MenuItem
          key={run.id}
          onSelect={() => navigate(`/sources?source=${encodeURIComponent(run.sourceId)}`)}
        >
          <StatusDot domain="run" status={run.status} size="sm" plain />
          <span className="sync-menu-run">
            <span className="sync-menu-run-name truncate">{run.sourceName}</span>
            <span className="sync-menu-run-meta num">
              {statusMeta('run', run.status).label} · {run.trigger} ·{' '}
              {relativeTime(run.queuedAt, now)}
            </span>
          </span>
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem onSelect={() => navigate('/sources')}>
        <CloudIcon />
        View cloud sources
      </MenuItem>
    </Menu>
  )
}
