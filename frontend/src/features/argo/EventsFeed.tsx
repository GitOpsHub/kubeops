import { useCallback, useMemo, useState } from 'react'
import { getTargetEvents, type EventFilter } from '../../api/argo'
import type { ApplicationDeployment } from '../../api/onboarding'
import { KubernetesResourceIcon } from '../../components/KubernetesResourceIcon'
import { EmptyIcon } from '../../components/icons'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { ErrorState } from '../../components/ui/ErrorState'
import { Select, Switch } from '../../components/ui/Field'
import { LoadingState } from '../../components/ui/LoadingState'
import { RefreshIndicator } from '../../components/ui/RefreshIndicator'
import { SearchInput } from '../../components/ui/SearchInput'
import { StatusDot } from '../../components/ui/StatusDot'
import { Timestamp } from '../../components/ui/Timestamp'
import { usePolledResource } from '../../hooks/usePolledResource'
import { eventKinds, filterEvents, groupEvents, isWarning } from './events'
import './argo.css'

const pollIntervalMs = 15_000

type Props = {
  onboardingId: string
  target: ApplicationDeployment
  /** Narrows the feed to one object, e.g. from a resource's Info panel. */
  scope?: EventFilter
  onClearScope?: () => void
}

/**
 * Kubernetes events as Argo CD relays them. Without a scope that is the
 * Application's own events (sync started, resource updated, health changed);
 * with one, a single object's.
 */
export function EventsFeed({ onboardingId, target, scope, onClearScope }: Props) {
  const [warningsOnly, setWarningsOnly] = useState(false)
  const [kind, setKind] = useState('')
  const [search, setSearch] = useState('')

  const scopeKey = JSON.stringify(scope ?? {})
  const load = useCallback(
    (signal: AbortSignal) =>
      getTargetEvents(onboardingId, target.id, JSON.parse(scopeKey) as EventFilter, signal),
    [onboardingId, target.id, scopeKey],
  )
  const query = usePolledResource(load, { intervalMs: pollIntervalMs })
  const events = useMemo(() => query.data ?? [], [query.data])
  const kinds = useMemo(() => eventKinds(events), [events])
  const visible = useMemo(
    () => groupEvents(filterEvents(events, { warningsOnly, kind, search })),
    [events, warningsOnly, kind, search],
  )
  const warnings = events.filter(isWarning).length
  const filtered = warningsOnly || kind !== '' || search.trim() !== ''
  const scoped = Boolean(scope && (scope.uid || scope.name))

  let body
  if (query.loading) {
    body = <LoadingState label="Loading events…" rows={4} />
  } else if (query.error && !query.data) {
    body = (
      <ErrorState
        title="Events could not be loaded"
        message={query.error.message}
        onRetry={() => void query.reload()}
      />
    )
  } else if (events.length === 0) {
    body = (
      <EmptyState
        compact
        icon={<EmptyIcon />}
        title="No recent events"
        description="Kubernetes keeps events for about an hour, so a quiet application has none. Events appear here as Argo CD syncs and the cluster reacts."
      />
    )
  } else if (visible.length === 0) {
    body = (
      <EmptyState
        compact
        title="No events match these filters"
        description="Try a different kind or search, or show every event type."
        action={
          <Button
            size="sm"
            onClick={() => {
              setWarningsOnly(false)
              setKind('')
              setSearch('')
            }}
          >
            Clear filters
          </Button>
        }
      />
    )
  } else {
    body = (
      <div className="event-groups">
        {visible.map((group) => (
          <section
            key={group.key}
            className="event-group"
            aria-label={`${group.object.kind} ${group.object.name}`}
          >
            <header className="event-group-head">
              <KubernetesResourceIcon kind={group.object.kind} />
              <span className="event-group-kind">{group.object.kind}</span>
              <strong className="mono truncate">{group.object.name}</strong>
              {group.warnings > 0 && (
                <span className="event-warnings" data-tone="warn">
                  {group.warnings} {group.warnings === 1 ? 'warning' : 'warnings'}
                </span>
              )}
            </header>
            <ol className="event-list">
              {group.events.map((event, index) => (
                <li
                  key={`${event.reason}-${event.lastSeen}-${index}`}
                  className="event-row"
                  data-tone={isWarning(event) ? 'warn' : 'idle'}
                >
                  <StatusDot
                    tone={isWarning(event) ? 'warn' : 'idle'}
                    size="sm"
                    label={isWarning(event) ? 'Warning' : 'Normal'}
                  />
                  <strong className="event-reason">{event.reason}</strong>
                  <p className="event-message">{event.message}</p>
                  <span className="event-meta">
                    {event.count > 1 && (
                      <span className="event-count tabular" title={`Seen ${event.count} times`}>
                        ×{event.count}
                      </span>
                    )}
                    <Timestamp value={event.lastSeen ?? event.firstSeen} fallback="—" />
                  </span>
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    )
  }

  return (
    <div className="events-feed">
      {scoped && (
        <div className="events-scope" role="note">
          <span>
            Showing events for{' '}
            <strong className="mono">
              {[scope?.kind, scope?.name].filter(Boolean).join(' ') || 'one resource'}
            </strong>
          </span>
          {onClearScope && (
            <Button size="sm" variant="ghost" onClick={onClearScope}>
              Show application events
            </Button>
          )}
        </div>
      )}
      <div className="events-toolbar">
        <SearchInput
          label="Search events"
          placeholder="Search reason, message, object"
          value={search}
          onChange={setSearch}
          className="events-search"
        />
        <Select
          aria-label="Kind"
          value={kind}
          onChange={(event) => setKind(event.target.value)}
          className="events-kind"
        >
          <option value="">All kinds</option>
          {kinds.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </Select>
        <Switch
          label="Warnings only"
          checked={warningsOnly}
          onChange={(event) => setWarningsOnly(event.target.checked)}
        />
        <span className="events-count subtle tabular">
          {events.length} {events.length === 1 ? 'event' : 'events'}
          {warnings > 0 && ` · ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`}
          {filtered && ` · ${visible.reduce((sum, group) => sum + group.events.length, 0)} shown`}
        </span>
        <RefreshIndicator
          lastUpdated={query.lastUpdated}
          refreshing={query.refreshing}
          failed={Boolean(query.error)}
        />
      </div>
      {body}
    </div>
  )
}
