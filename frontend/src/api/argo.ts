/**
 * Clients for the target-scoped Argo CD console endpoints. The browser never
 * talks to the `/argo` proxy for these: every call goes through `/api`, which
 * validates input and never passes Argo's own error bodies through.
 */
import { apiUrl, ensureOk, request } from './client'
import type { PodLogEntry, ResourceRef } from './onboarding'

export type { PodLogEntry } from './onboarding'

function targetPath(onboardingId: string, targetId: string) {
  return (
    `/application-onboardings/${encodeURIComponent(onboardingId)}` +
    `/targets/${encodeURIComponent(targetId)}`
  )
}

/** Kinds the logs endpoint accepts; workload kinds merge every pod they own. */
export const loggableKinds = ['Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job']

export function isLoggableKind(kind: string) {
  return loggableKinds.some((item) => item.toLowerCase() === kind.toLowerCase())
}

/** Workloads stream several pods at once, so each line needs its pod shown. */
export function isMultiPodKind(kind: string) {
  return isLoggableKind(kind) && kind.toLowerCase() !== 'pod'
}

/** Only kind and name are required; group and version are ignored for logs. */
export type LogResourceRef = Pick<ResourceRef, 'kind' | 'name'> &
  Partial<Pick<ResourceRef, 'namespace' | 'group' | 'version'>>

export type LogStreamOptions = {
  onboardingId: string
  targetId: string
  ref: LogResourceRef
  container?: string
  /** 1–5000; the server defaults to 500. */
  tailLines?: number
  sinceSeconds?: number
  /** RFC3339. Mutually exclusive with `sinceSeconds`. */
  sinceTime?: string
  /** The previous (crashed) container instance. */
  previous?: boolean
  /** The server follows by default; pass false for a one-shot read. */
  follow?: boolean
  /** Server-side substring filter, one line of at most 256 characters. */
  filter?: string
  signal: AbortSignal
  onEntry: (entry: PodLogEntry) => void
  /** Called once the server has accepted the request, before any line. */
  onOpen?: () => void
}

export function logStreamQuery(options: Omit<LogStreamOptions, 'signal' | 'onEntry' | 'onOpen'>) {
  const { ref } = options
  const params = new URLSearchParams({ kind: ref.kind, name: ref.name })
  if (ref.namespace) params.set('namespace', ref.namespace)
  if (ref.group) params.set('group', ref.group)
  if (ref.version) params.set('version', ref.version)
  if (options.container) params.set('container', options.container)
  if (options.tailLines) params.set('tailLines', String(options.tailLines))
  // sinceTime wins: a resumed stream must start exactly where the last one
  // stopped, and the server rejects both together.
  if (options.sinceTime) params.set('sinceTime', options.sinceTime)
  else if (options.sinceSeconds) params.set('sinceSeconds', String(options.sinceSeconds))
  if (options.previous) params.set('previous', 'true')
  if (options.follow === false) params.set('follow', 'false')
  if (options.filter) params.set('filter', options.filter)
  return params
}

/**
 * Follows the backend's NDJSON log stream until it ends or the caller aborts.
 * Partial network chunks are buffered so one entry is never parsed before its
 * newline arrives; a final `{error}` line rejects with that message. Resolves
 * when the server closes the stream, which for a following stream usually
 * means the function hit its maximum duration — callers decide whether to
 * resume.
 */
export async function streamTargetLogs(options: LogStreamOptions) {
  const { signal, onEntry } = options
  const query = logStreamQuery(options)
  const response = await ensureOk(
    await fetch(apiUrl(`${targetPath(options.onboardingId, options.targetId)}/logs?${query}`), {
      signal,
    }),
  )
  if (!response.body) throw new Error('The log stream is unavailable')
  options.onOpen?.()

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  const consume = (line: string) => {
    if (!line.trim()) return
    const entry = JSON.parse(line) as PodLogEntry
    if (entry.error) throw new Error(entry.error)
    onEntry(entry)
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      buffered += decoder.decode(value, { stream: !done })
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) consume(line)
      if (done) break
    }
    consume(buffered)
  } finally {
    // An error line ends the stream from our side; release the connection.
    reader.cancel().catch(() => undefined)
  }
}

export type ResourceContainer = {
  name: string
  image: string
  init: boolean
}

/** Containers from the live manifest, init containers first. */
export async function getResourceContainers(
  onboardingId: string,
  targetId: string,
  ref: LogResourceRef,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({
    group: ref.group ?? '',
    // The endpoint requires a version; every loggable kind is served at v1.
    version: ref.version || 'v1',
    kind: ref.kind,
    namespace: ref.namespace ?? '',
    name: ref.name,
  })
  const response = await request<{ items: ResourceContainer[] }>(
    `${targetPath(onboardingId, targetId)}/resources/containers?${params}`,
    { signal },
  )
  return response.items ?? []
}
