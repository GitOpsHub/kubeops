import { useCallback } from 'react'
import {
  getApplicationOperations,
  getTargetEvents,
  getValuesRevisions,
  type ArgoAppStatus,
  type KubeEvent,
} from '../../api/argo'
import type { ApplicationOnboarding } from '../../api/onboarding'
import { InfoIcon } from '../../components/icons'
import { usePolledResource } from '../../hooks/usePolledResource'
import { relativeTime } from '../../lib/format'
import { isWarning } from '../argo/events'
import { buildTimeline, type TimelineEvent, type TimelineIcon } from './timeline-events'
import './timeline.css'

/**
 * The application's history as one dated log: what KubeOps was asked to do,
 * what changed in Git, what Argo CD deployed, and what the cluster warned
 * about. Each source is optional — one that fails leaves a note rather than
 * an empty tab, and the record's own timestamps are always there.
 */

function dayLabel(value: string, now: Date) {
  const at = new Date(value)
  const days = Math.round(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()) /
      86_400_000,
  )
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

const icons: Record<TimelineIcon, string> = {
  onboard: 'M9 3.5v11M4.5 9h9',
  rollout: 'M3.5 9h5l1.5-3 2 6 1.5-3h3',
  complete: 'M4 9.5 7.5 13 14 5.5',
  update: 'M14 9a5 5 0 1 1-1.6-3.7M14 3v3h-3',
  offboard: 'M4.5 5.5h9M7 5.5V4h4v1.5M6 5.5l.6 8.5h6.8l.6-8.5',
  commit: 'M2.5 9h4M11.5 9h4M9 6.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5',
  deploy: 'M9 14V4M5 8l4-4 4 4M4.5 14.5h9',
  warning: 'M9 3.5 15 14H3L9 3.5ZM9 8v2.5M9 12.3v.2',
  stop: 'M5.5 5.5h7v7h-7z',
}

function TimelineRow({ event, now }: { event: TimelineEvent; now: number }) {
  return (
    <li className={`timeline-entry timeline-entry--${event.tone}`} data-tone={event.tone}>
      <span className="timeline-marker" aria-hidden="true">
        <svg viewBox="0 0 18 18">
          <path d={icons[event.icon]} />
        </svg>
      </span>
      <div className="timeline-copy">
        <div className="timeline-headline">
          <strong>{event.title}</strong>
          {event.meta && <span className="timeline-meta">{event.meta}</span>}
          {event.href && (
            <a href={event.href} target="_blank" rel="noreferrer">
              {event.hrefLabel ?? 'Open ↗'}
            </a>
          )}
        </div>
        {event.detail && <span className="timeline-detail">{event.detail}</span>}
      </div>
      {event.at ? (
        <time
          className="timeline-when"
          dateTime={event.at}
          title={new Date(event.at).toLocaleString()}
        >
          {relativeTime(event.at, now)}
        </time>
      ) : (
        <span className="timeline-when timeline-when--pending">Pending</span>
      )}
    </li>
  )
}

type Props = {
  record: ApplicationOnboarding
  statuses?: Record<string, ArgoAppStatus | undefined>
}

export function ApplicationTimeline({ record, statuses = {} }: Props) {
  const targetKey = record.targets.map((target) => target.id).join(',')
  const load = useCallback(
    async (signal: AbortSignal) => {
      const targetIds = targetKey ? targetKey.split(',') : []
      const [operations, revisions, ...events] = await Promise.allSettled([
        getApplicationOperations(record.id, 50, signal),
        getValuesRevisions(record.id, 20, signal),
        ...targetIds.map((id) => getTargetEvents(record.id, id, {}, signal)),
      ])
      const warnings: Record<string, KubeEvent[]> = {}
      targetIds.forEach((id, index) => {
        const result = events[index]
        if (result.status === 'fulfilled') {
          warnings[id] = (result.value as KubeEvent[]).filter(isWarning)
        }
      })
      return {
        operations: operations.status === 'fulfilled' ? operations.value : undefined,
        commits: revisions.status === 'fulfilled' ? revisions.value.items : undefined,
        warnings,
        missing: [
          operations.status === 'rejected' && 'the KubeOps audit trail',
          revisions.status === 'rejected' && 'Git history',
          events.some((result) => result.status === 'rejected') && 'cluster warnings',
        ].filter(Boolean) as string[],
      }
    },
    [record.id, targetKey],
  )
  const query = usePolledResource(load)
  const sources = query.data
  const events = buildTimeline(record, { ...sources, statuses })

  const now = new Date()
  const pending = events.filter((event) => !event.at)
  const dated = events.filter((event) => event.at)

  // Consecutive events on the same calendar day share one heading.
  const days: { label: string; events: TimelineEvent[] }[] = []
  for (const event of dated) {
    const label = dayLabel(event.at as string, now)
    const current = days[days.length - 1]
    if (current?.label === label) current.events.push(event)
    else days.push({ label, events: [event] })
  }

  return (
    <div className="timeline" aria-busy={query.loading}>
      {query.loading && (
        <p className="timeline-note" role="status">
          <span className="spinner" aria-hidden="true" />
          Loading deploys, commits, and warnings…
        </p>
      )}
      {sources && sources.missing.length > 0 && (
        <p className="timeline-note">
          <InfoIcon aria-hidden="true" />
          Not shown: {sources.missing.join(', ')} could not be loaded.
        </p>
      )}
      {pending.length > 0 && (
        <section className="timeline-day">
          <h3 className="timeline-day-label">In progress</h3>
          <ul>
            {pending.map((event) => (
              <TimelineRow key={event.id} event={event} now={now.getTime()} />
            ))}
          </ul>
        </section>
      )}
      {days.map((day) => (
        <section className="timeline-day" key={day.label}>
          <h3 className="timeline-day-label">{day.label}</h3>
          <ul>
            {day.events.map((event) => (
              <TimelineRow key={event.id} event={event} now={now.getTime()} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
