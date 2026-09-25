import type { ApplicationOperation, ArgoAppStatus, KubeEvent, ValuesRevision } from '../../api/argo'
import type { ApplicationOnboarding } from '../../api/onboarding'
import { initiatorLabel, shortSha, valuesRevisionOf } from '../argo/operation-phases'
import { statusMeta, type Tone } from '../../lib/status'

export type TimelineIcon =
  | 'onboard'
  | 'rollout'
  | 'complete'
  | 'update'
  | 'offboard'
  | 'commit'
  | 'deploy'
  | 'warning'
  | 'stop'

export type TimelineEvent = {
  id: string
  at: string | null
  title: string
  detail?: string
  meta?: string
  tone: Tone
  href?: string
  hrefLabel?: string
  icon: TimelineIcon
}

export type TimelineSources = {
  operations?: ApplicationOperation[]
  commits?: ValuesRevision[]
  statuses?: Record<string, ArgoAppStatus | undefined>
  /** Warning events per target ID. */
  warnings?: Record<string, KubeEvent[]>
}

/**
 * The record's own timestamps, which are all there is without the console
 * endpoints. Nothing is given an invented time: the values commit rides along
 * as the detail of the update it belongs to, and a stage that has not
 * happened yet is shown as pending rather than dated.
 */
function recordEvents(record: ApplicationOnboarding): TimelineEvent[] {
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
      tone: statusMeta('lifecycle', target.status).tone,
      href: target.argoApplicationUrl,
      hrefLabel: 'Argo CD ↗',
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
  return events
}

function operationEvent(
  operation: ApplicationOperation,
  clusterNames: Map<string, string>,
): TimelineEvent {
  const params = operation.params
  const cluster = operation.targetId ? clusterNames.get(operation.targetId) : undefined
  const targetIds = Array.isArray(params.targetIds) ? (params.targetIds as string[]) : []
  const scope =
    targetIds.length > 0
      ? targetIds.map((id) => clusterNames.get(id) ?? id).join(', ')
      : 'every target'
  const flags = [
    params.prune === false ? 'no prune' : params.prune ? 'prune' : '',
    params.force ? 'force' : '',
    params.applyOutOfSyncOnly ? 'out-of-sync only' : '',
  ]
    .filter(Boolean)
    .join(', ')

  const described: Record<
    ApplicationOperation['kind'],
    Pick<TimelineEvent, 'title' | 'icon'> & { detail?: string }
  > = {
    sync: {
      title: 'Sync requested',
      icon: 'rollout',
      detail: [scope, flags].filter(Boolean).join(' · '),
    },
    'dry-run': { title: 'Dry run requested', icon: 'rollout', detail: scope },
    rollback: {
      title: `Values rolled back to ${shortSha(String(params.commitSha ?? ''))}`,
      icon: 'update',
      detail: params.valuesCommitSha
        ? `New commit ${shortSha(String(params.valuesCommitSha))}`
        : undefined,
    },
    terminate: { title: `Sync terminated${cluster ? ` on ${cluster}` : ''}`, icon: 'stop' },
    scale: {
      title: `Scaled to ${String(params.replicas ?? '?')} ${params.replicas === 1 ? 'pod' : 'pods'}`,
      icon: 'update',
    },
    offboard: { title: 'Offboard requested', icon: 'offboard' },
  }
  const entry = described[operation.kind] ?? { title: operation.kind, icon: 'update' as const }
  const failed = operation.result === 'failed'
  return {
    id: `operation-${operation.id}`,
    at: operation.createdAt,
    title: failed ? `${entry.title} (rejected)` : entry.title,
    detail: entry.detail,
    meta: 'via KubeOps',
    tone: failed ? 'err' : 'info',
    icon: entry.icon,
  }
}

/** Every dated thing known about this release, newest first, pending on top. */
export function buildTimeline(
  record: ApplicationOnboarding,
  sources: TimelineSources = {},
): TimelineEvent[] {
  const clusterNames = new Map(record.targets.map((target) => [target.id, target.clusterName]))
  const events = recordEvents(record)

  for (const operation of sources.operations ?? []) {
    events.push(operationEvent(operation, clusterNames))
  }

  for (const commit of sources.commits ?? []) {
    events.push({
      id: `commit-${commit.sha}`,
      at: commit.committedAt,
      title: commit.message || 'Values commit',
      meta: `${shortSha(commit.sha)} · ${commit.author || 'unknown author'}`,
      tone: 'idle',
      href: commit.url,
      hrefLabel: 'GitHub ↗',
      icon: 'commit',
    })
  }

  for (const target of record.targets) {
    const history = sources.statuses?.[target.id]?.history ?? []
    for (const entry of history) {
      const values = valuesRevisionOf(entry.revisions)
      events.push({
        id: `deploy-${target.id}-${entry.id}`,
        at: entry.deployedAt ?? entry.deployStartedAt,
        title: `Deployed to ${target.clusterName}`,
        detail: [
          values ? `values ${shortSha(values)}` : '',
          entry.revisions.length > 1 ? `chart ${entry.revisions[0]}` : '',
        ]
          .filter(Boolean)
          .join(' · '),
        meta: initiatorLabel(entry.initiatedBy),
        tone: 'ok',
        icon: 'deploy',
      })
    }
    for (const [index, event] of (sources.warnings?.[target.id] ?? []).entries()) {
      events.push({
        id: `warning-${target.id}-${index}`,
        at: event.lastSeen ?? event.firstSeen,
        title: `${event.reason} on ${target.clusterName}`,
        detail: event.message,
        meta: event.count > 1 ? `×${event.count}` : undefined,
        tone: 'warn',
        icon: 'warning',
      })
    }
  }

  return events.sort((left, right) => {
    if (!left.at) return -1
    if (!right.at) return 1
    return right.at.localeCompare(left.at)
  })
}
