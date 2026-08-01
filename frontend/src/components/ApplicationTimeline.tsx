import type { ApplicationOnboarding } from '../api/onboarding'
import { relativeTime } from '../lib/resource-tree'

/**
 * The application lifecycle as a dated log.
 *
 * There is no events API — the record carries timestamps, not history — so
 * every entry here is derived from a field that is genuinely timestamped.
 * Nothing is given an invented time: the values commit rides along as the
 * detail of the update it belongs to, and a stage that has not happened yet is
 * shown as pending rather than dated.
 */

type Tone = 'ok' | 'warn' | 'err' | 'idle'

type TimelineEvent = {
  id: string
  at: string | null
  title: string
  detail?: string
  meta?: string
  tone: Tone
  href?: string
  icon: 'onboard' | 'rollout' | 'complete' | 'update' | 'offboard'
}

function statusTone(status: string): Tone {
  switch (status) {
    case 'healthy':
      return 'ok'
    case 'failed':
      return 'err'
    case 'offboarded':
      return 'idle'
    default:
      return 'warn'
  }
}

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

const icons: Record<TimelineEvent['icon'], string> = {
  onboard: 'M9 3.5v11M4.5 9h9',
  rollout: 'M3.5 9h5l1.5-3 2 6 1.5-3h3',
  complete: 'M4 9.5 7.5 13 14 5.5',
  update: 'M14 9a5 5 0 1 1-1.6-3.7M14 3v3h-3',
  offboard: 'M4.5 5.5h9M7 5.5V4h4v1.5M6 5.5l.6 8.5h6.8l.6-8.5',
}

function buildTimeline(record: ApplicationOnboarding): TimelineEvent[] {
  const events: TimelineEvent[] = [
    {
      id: 'onboarded',
      at: record.createdAt,
      title: 'Onboarded',
      detail: `${record.environment}-${record.region} · ${record.namespace}`,
      tone: 'idle',
      icon: 'onboard',
    },
  ]

  if (record.updatedAt && record.updatedAt !== record.createdAt) {
    const revision = record.valuesCommitSha || record.valuesRevision
    events.push({
      id: 'updated',
      at: record.updatedAt,
      title: 'Configuration updated',
      detail: `${record.chartName} ${record.chartRevision}`,
      meta: revision ? `values ${revision.slice(0, 12)}` : undefined,
      tone: 'idle',
      icon: 'update',
    })
  }

  for (const target of record.targets) {
    events.push({
      id: `target-${target.id}`,
      at: target.updatedAt,
      title: `${target.clusterName} · ${target.status}`,
      detail: target.message || `${target.syncStatus} · ${target.healthStatus}`,
      meta: target.region,
      tone: statusTone(target.status),
      href: target.argoApplicationUrl,
      icon: target.status === 'offboarded' ? 'offboard' : 'rollout',
    })
  }

  events.push(
    record.completedAt
      ? {
          id: 'completed',
          at: record.completedAt,
          title: 'Rollout completed',
          detail: 'Every deployment target reached its desired state.',
          tone: 'ok',
          icon: 'complete',
        }
      : {
          id: 'completed',
          at: null,
          title: 'Rollout completed',
          detail: 'Waiting for every deployment target to settle.',
          tone: 'idle',
          icon: 'complete',
        },
  )

  // Newest first, with anything still pending held above the dated log.
  return events.sort((left, right) => {
    if (!left.at) return -1
    if (!right.at) return 1
    return right.at.localeCompare(left.at)
  })
}

function TimelineRow({ event, now }: { event: TimelineEvent; now: number }) {
  return (
    <li className={`timeline-entry timeline-entry--${event.tone}`}>
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
              Argo CD ↗
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

export function ApplicationTimeline({ record }: { record: ApplicationOnboarding }) {
  const events = buildTimeline(record)
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
    <div className="timeline">
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
