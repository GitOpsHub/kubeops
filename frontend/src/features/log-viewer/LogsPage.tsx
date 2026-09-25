import { useCallback, useEffect, useMemo } from 'react'
import { Link, useOutletContext, useParams, useSearchParams } from 'react-router-dom'
import { isLoggableKind, isMultiPodKind, type LogResourceRef } from '../../api/argo'
import { ApiError } from '../../api/client'
import {
  getApplicationOnboarding,
  getTargetResources,
  type ResourceNode,
} from '../../api/onboarding'
import { LogsIcon } from '../../components/icons'
import { buttonClass } from '../../components/ui/button-class'
import { EmptyState } from '../../components/ui/EmptyState'
import { ErrorState } from '../../components/ui/ErrorState'
import { LoadingState } from '../../components/ui/LoadingState'
import { PageHeader } from '../../components/ui/PageHeader'
import { usePolledResource } from '../../hooks/usePolledResource'
import type { AppShellContext } from '../../lib/app-shell'
import { LogViewer } from './LogViewer'
import './log-viewer.css'

// Workloads first: "all pods of the Deployment" is usually what is wanted.
const kindOrder = ['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'ReplicaSet', 'Pod']

function resourceKey(ref: LogResourceRef) {
  return `${ref.kind}/${ref.namespace ?? ''}/${ref.name}`
}

function loggableResources(nodes: ResourceNode[]) {
  return nodes
    .filter((node) => isLoggableKind(node.kind))
    .sort(
      (left, right) =>
        kindOrder.indexOf(left.kind) - kindOrder.indexOf(right.kind) ||
        left.name.localeCompare(right.name),
    )
}

/**
 * The log viewer with the whole window to itself. Everything that picks what
 * is streamed lives in the URL, so a link pasted into an incident channel
 * opens the same target, resource, and container.
 */
export function LogsPage() {
  const { id = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const { setApplicationTopbar } = useOutletContext<AppShellContext>()

  const loadRecord = useCallback(
    (signal: AbortSignal) => getApplicationOnboarding(id, signal),
    [id],
  )
  const recordQuery = usePolledResource(loadRecord)
  const record = recordQuery.data
  const missing = recordQuery.error instanceof ApiError && recordQuery.error.status === 404

  const targets = useMemo(() => record?.targets ?? [], [record])
  const requestedTarget = params.get('target') ?? ''
  const target = targets.find((item) => item.id === requestedTarget) ?? targets[0]
  const targetId = target?.id ?? ''

  const loadResources = useCallback(
    (signal: AbortSignal) => getTargetResources(id, targetId, signal),
    [id, targetId],
  )
  const resourcesQuery = usePolledResource(loadResources, { enabled: Boolean(targetId) })
  const candidates = useMemo(
    () => loggableResources(resourcesQuery.data ?? []),
    [resourcesQuery.data],
  )

  // A deep-linked resource is honoured even when it is not (or no longer) in
  // the tree, e.g. a pod that has since been replaced still has previous logs.
  const kind = params.get('kind') ?? ''
  const name = params.get('name') ?? ''
  const namespace = params.get('namespace') ?? ''
  const fallback = candidates.find((node) => isMultiPodKind(node.kind)) ?? candidates[0]
  const resource: LogResourceRef | null =
    kind && name
      ? { kind, name, namespace }
      : fallback
        ? { kind: fallback.kind, name: fallback.name, namespace: fallback.namespace }
        : null

  const recordName = record?.name
  useEffect(() => {
    setApplicationTopbar(recordName ? { name: recordName } : null)
  }, [recordName, setApplicationTopbar])
  useEffect(() => () => setApplicationTopbar(null), [setApplicationTopbar])

  function pick(next: { target: string; resource?: LogResourceRef }) {
    const search = new URLSearchParams({ target: next.target })
    if (next.resource) {
      search.set('kind', next.resource.kind)
      search.set('name', next.resource.name)
      if (next.resource.namespace) search.set('namespace', next.resource.namespace)
    }
    setParams(search, { replace: true })
  }

  const back = { to: `/applications/${encodeURIComponent(id)}`, label: recordName ?? 'Back' }

  if (recordQuery.loading) {
    return (
      <div className="logs-page">
        <LoadingState label="Loading application…" shape="none" />
      </div>
    )
  }

  if (missing || (!record && recordQuery.error)) {
    return (
      <div className="logs-page">
        <PageHeader title="Logs" back={{ to: '/applications', label: 'Applications' }} />
        {missing ? (
          <EmptyState
            title="Application not found"
            description="It may have been offboarded, or the link is wrong."
            action={
              <Link className={buttonClass('secondary', 'sm')} to="/applications">
                View applications
              </Link>
            }
          />
        ) : (
          <ErrorState
            title="The application could not be loaded"
            message={recordQuery.error?.message}
            onRetry={() => void recordQuery.reload()}
          />
        )}
      </div>
    )
  }

  if (!record) return null

  const pickers = (
    <>
      {targets.length > 1 ? (
        <label className="log-field">
          <span>Target</span>
          <select
            className="select"
            value={targetId}
            onChange={(event) => pick({ target: event.target.value })}
          >
            {targets.map((item) => (
              <option key={item.id} value={item.id}>
                {item.clusterName} · {item.region}
              </option>
            ))}
          </select>
        </label>
      ) : (
        target && (
          <span className="log-resource">
            <span className="log-resource-kind">Target</span>
            <span className="log-resource-name">{target.clusterName}</span>
          </span>
        )
      )}
      <label className="log-field">
        <span>Resource</span>
        <select
          className="select"
          value={resource ? resourceKey(resource) : ''}
          disabled={resourcesQuery.loading && !resource}
          onChange={(event) => {
            const chosen = candidates.find((node) => resourceKey(node) === event.target.value)
            if (chosen) pick({ target: targetId, resource: chosen })
          }}
        >
          {resource && !candidates.some((node) => resourceKey(node) === resourceKey(resource)) && (
            <option value={resourceKey(resource)}>
              {resource.kind} {resource.name}
            </option>
          )}
          {kindOrder
            .filter((item) => candidates.some((node) => node.kind === item))
            .map((item) => (
              <optgroup key={item} label={item}>
                {candidates
                  .filter((node) => node.kind === item)
                  .map((node) => (
                    <option key={node.uid} value={resourceKey(node)}>
                      {node.name}
                    </option>
                  ))}
              </optgroup>
            ))}
        </select>
      </label>
    </>
  )

  let body
  if (!target) {
    body = (
      <EmptyState
        icon={<LogsIcon />}
        title="No deployment targets"
        description="This application is not deployed to any cluster, so there are no logs to read."
        action={
          <Link className={buttonClass('secondary', 'sm')} to={back.to}>
            Back to {record.name}
          </Link>
        }
      />
    )
  } else if (resource) {
    body = (
      <LogViewer
        key={`${targetId}/${resourceKey(resource)}`}
        onboardingId={id}
        targetId={targetId}
        resource={resource}
        initialContainer={params.get('container') ?? ''}
        onContainerChange={(container) =>
          setParams(
            (current) => {
              const next = new URLSearchParams(current)
              next.set('container', container)
              return next
            },
            { replace: true },
          )
        }
        pickers={pickers}
      />
    )
  } else if (resourcesQuery.loading) {
    body = <LoadingState label="Loading resources…" shape="none" />
  } else if (resourcesQuery.error) {
    body = (
      <ErrorState
        title="Resources could not be loaded"
        message={resourcesQuery.error.message}
        onRetry={() => void resourcesQuery.reload()}
      />
    )
  } else {
    body = (
      <EmptyState
        icon={<LogsIcon />}
        title="Nothing to read logs from"
        description={`Argo CD reports no pods or workloads on ${target.clusterName} yet. Deploy the application, then come back.`}
        action={
          <Link className={buttonClass('secondary', 'sm')} to={back.to}>
            Back to {record.name}
          </Link>
        }
      />
    )
  }

  return (
    <div className="logs-page">
      <PageHeader
        title="Logs"
        description={`${record.name} · ${record.environment} · ${record.region}`}
        back={back}
      />
      <section className="logs-page-panel" aria-label="Log viewer">
        {body}
      </section>
    </div>
  )
}
