/**
 * Clients for the target-scoped Argo CD console endpoints. The browser never
 * talks to the `/argo` proxy for these: every call goes through `/api`, which
 * validates input and never passes Argo's own error bodies through.
 */
import { apiUrl, ensureOk, request, requestVoid } from './client'
import type { ApplicationOnboarding, PodLogEntry, ResourceRef } from './onboarding'

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

// Sync operations, events, and values history ----------------------------

export type ArgoInitiator = { username?: string; automated: boolean }

/** One object's result within a sync operation, including hooks. */
export type ArgoOperationResource = {
  group: string
  version: string
  kind: string
  namespace: string
  name: string
  /** Synced, SyncFailed, Pruned, PruneSkipped, OutOfSync… */
  status: string
  message?: string
  /** PreSync, Sync, PostSync, SyncFail, Skip — set on hooks only. */
  hookType?: string
  /** Running, Succeeded, Failed, Error, Terminating — set on hooks only. */
  hookPhase?: string
  /** PreSync, Sync, PostSync, SyncFail: the wave the result belongs to. */
  syncPhase?: string
}

export type ArgoOperationPhase = 'Running' | 'Terminating' | 'Succeeded' | 'Failed' | 'Error'

export type ArgoOperation = {
  phase: ArgoOperationPhase
  message?: string
  startedAt: string | null
  finishedAt: string | null
  retryCount: number
  initiatedBy: ArgoInitiator
  dryRun: boolean
  prune: boolean
  /** Multi-source apps report `[chartVersion, valuesRepoSha]`. */
  revisions: string[]
  resources: ArgoOperationResource[]
}

export type ArgoHistoryEntry = {
  id: number
  revisions: string[]
  deployStartedAt: string | null
  deployedAt: string | null
  initiatedBy: ArgoInitiator
}

export type ArgoCondition = { type: string; message: string; lastTransitionTime: string | null }

/** An Argo CD Application's live state on one target. Arrays are never null. */
export type ArgoAppStatus = {
  sync: { status: string; revisions: string[] }
  health: { status: string; message?: string }
  operation: ArgoOperation | null
  /** Newest first. */
  history: ArgoHistoryEntry[]
  conditions: ArgoCondition[]
  images: string[]
  reconciledAt: string | null
}

export function getTargetArgoStatus(onboardingId: string, targetId: string, signal?: AbortSignal) {
  return request<ArgoAppStatus>(`${targetPath(onboardingId, targetId)}/argo`, { signal })
}

/** Stops the running sync. Rejects with a 409 when nothing is running. */
export function terminateTargetOperation(onboardingId: string, targetId: string) {
  return requestVoid(`${targetPath(onboardingId, targetId)}/operation`, { method: 'DELETE' })
}

export type KubeEvent = {
  type: 'Normal' | 'Warning' | string
  reason: string
  message: string
  count: number
  firstSeen: string | null
  lastSeen: string | null
  source?: string
  object: { kind: string; name: string; namespace?: string; uid?: string }
}

/** Narrows events to one object; with neither name nor uid, the Application's own. */
export type EventFilter = { kind?: string; name?: string; namespace?: string; uid?: string }

export async function getTargetEvents(
  onboardingId: string,
  targetId: string,
  filter: EventFilter = {},
  signal?: AbortSignal,
) {
  const params = new URLSearchParams()
  for (const key of ['kind', 'name', 'namespace', 'uid'] as const) {
    if (filter[key]) params.set(key, filter[key] as string)
  }
  const query = params.toString() ? `?${params}` : ''
  const response = await request<{ items: KubeEvent[] }>(
    `${targetPath(onboardingId, targetId)}/events${query}`,
    { signal },
  )
  return response.items ?? []
}

export type SyncOptions = {
  /** Omitted or empty syncs every target. */
  targetIds?: string[]
  prune: boolean
  dryRun: boolean
  force: boolean
  applyOutOfSyncOnly: boolean
}

export const defaultSyncOptions: SyncOptions = {
  prune: true,
  dryRun: false,
  force: false,
  applyOutOfSyncOnly: false,
}

/**
 * The request body for a sync, or null when the options are the server's
 * defaults. Sending no body then keeps a plain Deploy byte-for-byte the
 * request it has always been, which older servers accept too.
 */
export function syncRequestBody(options: SyncOptions) {
  const targetIds = options.targetIds?.filter(Boolean) ?? []
  const isDefault =
    targetIds.length === 0 &&
    options.prune === defaultSyncOptions.prune &&
    !options.dryRun &&
    !options.force &&
    !options.applyOutOfSyncOnly
  if (isDefault) return null
  return {
    ...(targetIds.length > 0 ? { targetIds } : {}),
    prune: options.prune,
    dryRun: options.dryRun,
    force: options.force,
    applyOutOfSyncOnly: options.applyOutOfSyncOnly,
  }
}

export function syncApplication(id: string, options: SyncOptions = defaultSyncOptions) {
  const body = syncRequestBody(options)
  const path = `/application-onboardings/${encodeURIComponent(id)}/sync`
  if (!body) return request<ApplicationOnboarding>(path, { method: 'POST' })
  return request<ApplicationOnboarding>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export type ValuesRevision = {
  sha: string
  /** The commit subject. */
  message: string
  author: string
  committedAt: string | null
  url: string
  /** The newest commit touching the values file; only ever the first item. */
  current: boolean
}

export type ValuesRevisionList = { path: string; branch: string; items: ValuesRevision[] }

/** Commits touching this release's values file, newest first. */
export function getValuesRevisions(onboardingId: string, limit = 20, signal?: AbortSignal) {
  return request<ValuesRevisionList>(
    `/application-onboardings/${encodeURIComponent(onboardingId)}/revisions?limit=${limit}`,
    { signal },
  )
}

/**
 * The values file at one commit. The server replaces secret-looking values
 * with `<redacted>` and lists their dotted paths; `*` means the file did not
 * parse and was withheld entirely.
 */
export type RevisionValues = {
  sha: string
  path: string
  valuesYaml: string
  redactedKeys: string[]
}

export function getRevisionValues(onboardingId: string, sha: string, signal?: AbortSignal) {
  return request<RevisionValues>(
    `/application-onboardings/${encodeURIComponent(onboardingId)}` +
      `/revisions/${encodeURIComponent(sha)}/values`,
    { signal },
  )
}

/** Commits the values file as it was at `commitSha`, then syncs. */
export function rollbackApplication(onboardingId: string, commitSha: string) {
  return request<ApplicationOnboarding>(
    `/application-onboardings/${encodeURIComponent(onboardingId)}/rollback`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commitSha }),
    },
  )
}

export type ApplicationOperationKind =
  'sync' | 'dry-run' | 'rollback' | 'terminate' | 'scale' | 'offboard'

/** An audit entry for a request KubeOps accepted (or, for some, rejected). */
export type ApplicationOperation = {
  id: string
  onboardingId: string
  targetId: string | null
  kind: ApplicationOperationKind
  params: Record<string, unknown>
  /** Whether KubeOps's request was accepted, not how the deployment went. */
  result: 'succeeded' | 'failed'
  createdAt: string
}

export async function getApplicationOperations(
  onboardingId: string,
  limit = 50,
  signal?: AbortSignal,
) {
  const response = await request<{ items: ApplicationOperation[] }>(
    `/application-onboardings/${encodeURIComponent(onboardingId)}/operations?limit=${limit}`,
    { signal },
  )
  return response.items ?? []
}
