import { useCallback, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { isLoggableKind, type LogResourceRef } from '../../api/argo'
import { getTargetResources, type ApplicationDeployment } from '../../api/onboarding'
import { ExternalLinkIcon, LogsIcon } from '../../components/icons'
import { buttonClass } from '../../components/ui/button-class'
import { EmptyState } from '../../components/ui/EmptyState'
import { ErrorState } from '../../components/ui/ErrorState'
import { LoadingState } from '../../components/ui/LoadingState'
import { usePolledResource } from '../../hooks/usePolledResource'
import { LogViewer } from '../log-viewer/LogViewer'
import { logsPageHref } from '../log-viewer/logs-link'
import '../log-viewer/log-viewer.css'

// Workloads first: "all pods of the Deployment" is usually what is wanted.
const kindOrder = ['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'ReplicaSet', 'Pod']

function resourceKey(ref: LogResourceRef) {
  return `${ref.kind}/${ref.namespace ?? ''}/${ref.name}`
}

type Props = {
  onboardingId: string
  /** The Deployment named after the application is the default choice. */
  applicationName: string
  target: ApplicationDeployment
}

/** Live logs for the selected cluster, beside everything else on the page. */
export function LogsTab({ onboardingId, applicationName, target }: Props) {
  const load = useCallback(
    (signal: AbortSignal) => getTargetResources(onboardingId, target.id, signal),
    [onboardingId, target.id],
  )
  const query = usePolledResource(load)
  const candidates = useMemo(
    () =>
      (query.data ?? [])
        .filter((node) => isLoggableKind(node.kind))
        .sort(
          (left, right) =>
            kindOrder.indexOf(left.kind) - kindOrder.indexOf(right.kind) ||
            left.name.localeCompare(right.name),
        ),
    [query.data],
  )
  const [picked, setPicked] = useState('')
  const fallback =
    candidates.find((node) => node.kind === 'Deployment' && node.name === applicationName) ??
    candidates[0]
  const node = candidates.find((item) => resourceKey(item) === picked) ?? fallback
  const resource: LogResourceRef | null = node
    ? { kind: node.kind, name: node.name, namespace: node.namespace }
    : null

  if (query.loading) return <LoadingState label="Loading resources…" shape="none" />
  if (query.error && !query.data) {
    return (
      <ErrorState
        title="Resources could not be loaded"
        message={query.error.message}
        onRetry={() => void query.reload()}
      />
    )
  }
  if (!resource) {
    return (
      <EmptyState
        icon={<LogsIcon />}
        title="Nothing to read logs from"
        description={`Argo CD reports no pods or workloads on ${target.clusterName} yet. Deploy the application, then come back.`}
      />
    )
  }

  const pickers = (
    <>
      <label className="log-field">
        <span>Resource</span>
        <select
          className="select"
          value={resourceKey(resource)}
          onChange={(event) => setPicked(event.target.value)}
        >
          {kindOrder
            .filter((kind) => candidates.some((item) => item.kind === kind))
            .map((kind) => (
              <optgroup key={kind} label={kind}>
                {candidates
                  .filter((item) => item.kind === kind)
                  .map((item) => (
                    <option key={item.uid} value={resourceKey(item)}>
                      {item.name}
                    </option>
                  ))}
              </optgroup>
            ))}
        </select>
      </label>
      <Link
        className={buttonClass('ghost', 'sm')}
        to={logsPageHref(onboardingId, target.id, resource)}
      >
        <ExternalLinkIcon aria-hidden="true" />
        Full screen
      </Link>
    </>
  )

  return (
    <div className="logs-tab">
      <LogViewer
        key={`${target.id}/${resourceKey(resource)}`}
        onboardingId={onboardingId}
        targetId={target.id}
        resource={resource}
        pickers={pickers}
      />
    </div>
  )
}
