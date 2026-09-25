import type { SyncRun } from '../../api/inventory'
import { Tooltip } from '../../components/ui/Tooltip'
import { plural, relativeTime } from '../../lib/format'
import { statusMeta } from '../../lib/status'
import { formatDuration, runDurationMs } from './run-format'
import './RunHistory.css'

type Props = {
  /** Newest first, as the API returns them. */
  runs: SyncRun[]
  /** How many ticks the strip holds; missing runs leave empty slots. */
  slots?: number
  /** Names the strip, e.g. the source it belongs to. */
  label: string
}

/**
 * A source's recent runs as a row of ticks, oldest left, newest right: a
 * glance says whether syncs have been reliable and whether one is running
 * now. The strip is one image to assistive technology, named with the tally,
 * because twenty individual ticks would be noise read aloud.
 */
export function RunHistory({ runs, slots = 20, label }: Props) {
  const shown = runs.slice(0, slots).reverse()
  const counts = new Map<string, number>()
  for (const run of shown) counts.set(run.status, (counts.get(run.status) ?? 0) + 1)
  const tally = [...counts.entries()].map(([status, count]) => `${count} ${status}`).join(', ')
  const summary = shown.length
    ? `${label}: last ${plural(shown.length, 'run')}, ${tally}`
    : `${label}: no runs yet`

  return (
    <div className="run-history" role="img" aria-label={summary}>
      {Array.from({ length: slots - shown.length }, (_, index) => (
        <span className="run-tick run-tick--empty" key={`empty-${index}`} />
      ))}
      {shown.map((run) => {
        const meta = statusMeta('run', run.status)
        return (
          <Tooltip
            key={run.id}
            content={`${meta.label} · ${run.trigger} · ${relativeTime(run.queuedAt)} · ${formatDuration(
              runDurationMs(run),
            )}`}
          >
            <span
              className={`run-tick${meta.inFlight ? ' run-tick--pulse' : ''}`}
              data-tone={meta.tone}
            />
          </Tooltip>
        )
      })}
    </div>
  )
}
