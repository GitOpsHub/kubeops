import type { ArgoOperation, ArgoOperationPhase, ArgoOperationResource } from '../../api/argo'
import { normalise, statusMeta, type StatusMeta } from '../../lib/status'

/**
 * How far an Argo CD sync operation has got, read off the little Argo CD
 * reports: an overall phase plus, per resource, the wave (`syncPhase`) it was
 * applied in and, for hooks, the hook's own phase. There is no "current wave"
 * field, so the furthest wave any resource has reached stands in for it.
 */

export type OperationOutcome = 'running' | 'terminating' | 'succeeded' | 'failed' | 'terminated'
export type PhaseStepState = 'complete' | 'current' | 'upcoming' | 'failed' | 'skipped'

export type PhaseStep = {
  id: 'queued' | 'PreSync' | 'Sync' | 'PostSync' | 'result'
  label: string
  state: PhaseStepState
  /** A count or a reason, e.g. "2 hooks" or "No hooks". */
  detail?: string
}

const waves = ['PreSync', 'Sync', 'PostSync'] as const
type Wave = (typeof waves)[number]

export function isInFlightPhase(phase: ArgoOperationPhase | string | null | undefined) {
  const value = normalise(phase ?? '')
  return value === 'running' || value === 'terminating'
}

export function operationOutcome(operation: ArgoOperation): OperationOutcome {
  switch (normalise(operation.phase)) {
    case 'running':
      return 'running'
    case 'terminating':
      return 'terminating'
    case 'succeeded':
      return 'succeeded'
    default:
      // Argo CD ends a terminated operation as Failed with a message saying so.
      return /terminat/i.test(operation.message ?? '') ? 'terminated' : 'failed'
  }
}

function waveOf(resource: ArgoOperationResource): Wave | null {
  const value = resource.syncPhase || resource.hookType || ''
  return waves.find((wave) => wave.toLowerCase() === value.toLowerCase()) ?? null
}

export function isFailedResource(resource: ArgoOperationResource) {
  const hook = normalise(resource.hookPhase ?? '')
  return (
    normalise(resource.status) === 'syncfailed' ||
    hook === 'failed' ||
    hook === 'error' ||
    normalise(resource.syncPhase ?? '') === 'syncfail'
  )
}

function countLabel(resources: ArgoOperationResource[], wave: Wave) {
  const inWave = resources.filter((resource) => waveOf(resource) === wave)
  if (inWave.length === 0) return undefined
  const hooks = inWave.filter((resource) => resource.hookType).length
  if (wave !== 'Sync' || hooks === inWave.length) {
    return `${hooks || inWave.length} ${(hooks || inWave.length) === 1 ? 'hook' : 'hooks'}`
  }
  return `${inWave.length} ${inWave.length === 1 ? 'resource' : 'resources'}`
}

/** Queued → PreSync → Sync → PostSync → the outcome, each with its state. */
export function deriveOperationSteps(operation: ArgoOperation): PhaseStep[] {
  const outcome = operationOutcome(operation)
  const { resources } = operation
  const present = new Set(resources.map(waveOf).filter(Boolean))
  const reached = Math.max(-1, ...resources.map((resource) => waves.indexOf(waveOf(resource)!)))
  const failing = resources.find(isFailedResource)
  const failedAt = failing && waveOf(failing) ? waves.indexOf(waveOf(failing)!) : null
  // A failure before any resource was applied (e.g. manifests that do not
  // render) belongs to the Sync wave rather than to the queue.
  const stopAt = failedAt ?? (reached >= 0 ? reached : waves.indexOf('Sync'))

  const waveState = (index: number, wave: Wave): PhaseStepState => {
    const skipped = wave !== 'Sync' && !present.has(wave)
    switch (outcome) {
      case 'succeeded':
        return skipped ? 'skipped' : 'complete'
      case 'failed':
      case 'terminated':
        if (index < stopAt) return skipped ? 'skipped' : 'complete'
        return index === stopAt ? 'failed' : 'upcoming'
      default:
        if (index < reached) return skipped ? 'skipped' : 'complete'
        return index === reached ? 'current' : 'upcoming'
    }
  }

  const running = outcome === 'running' || outcome === 'terminating'
  const resultLabel: Record<OperationOutcome, string> = {
    running: 'Complete',
    terminating: 'Terminating',
    succeeded: 'Succeeded',
    failed: 'Failed',
    terminated: 'Terminated',
  }

  return [
    {
      id: 'queued',
      label: 'Queued',
      state: running && reached < 0 ? 'current' : 'complete',
    },
    ...waves.map((wave, index) => {
      const state = waveState(index, wave)
      return {
        id: wave,
        label: wave,
        state,
        detail: state === 'skipped' ? 'No hooks' : countLabel(resources, wave),
      }
    }),
    {
      id: 'result',
      label: resultLabel[outcome],
      state: running ? 'upcoming' : outcome === 'succeeded' ? 'complete' : 'failed',
    },
  ]
}

/** 0–1, for a compact progress bar: the share of steps already behind it. */
export function operationProgress(operation: ArgoOperation) {
  const steps = deriveOperationSteps(operation)
  const done = steps.filter((step) => step.state === 'complete' || step.state === 'skipped').length
  const current = steps.some((step) => step.state === 'current') ? 0.5 : 0
  return Math.min(1, (done + current) / steps.length)
}

/** The step a running operation is on, for one-line summaries. */
export function currentPhaseLabel(operation: ArgoOperation) {
  if (operationOutcome(operation) === 'terminating') return 'Terminating'
  const current = deriveOperationSteps(operation).find((step) => step.state === 'current')
  return current ? `${current.label} phase` : 'Finishing'
}

const resultStatuses: Record<string, StatusMeta> = {
  synced: { tone: 'ok', label: 'Synced', icon: 'ok', inFlight: false },
  syncfailed: { tone: 'err', label: 'Sync failed', icon: 'err', inFlight: false },
  pruned: { tone: 'idle', label: 'Pruned', icon: 'removed', inFlight: false },
  pruneskipped: { tone: 'warn', label: 'Prune skipped', icon: 'warn', inFlight: false },
}

/** A hook reads by its own phase; anything else by its apply result. */
export function resourceResultMeta(resource: ArgoOperationResource): StatusMeta {
  if (resource.hookPhase) return statusMeta('operation', resource.hookPhase)
  return resultStatuses[normalise(resource.status)] ?? statusMeta('sync', resource.status)
}

const shaPattern = /^[0-9a-f]{7,40}$/i

export function isCommitSha(value: string | null | undefined) {
  return Boolean(value && shaPattern.test(value))
}

export function shortSha(value: string) {
  return isCommitSha(value) ? value.slice(0, 7) : value
}

/** The values-repo commit of a multi-source revision list `[chart, values]`. */
export function valuesRevisionOf(revisions: string[]) {
  return revisions.length > 1 ? revisions[1] : (revisions[0] ?? '')
}

/** "0:42", "12:05", "1:02:03": a stopwatch, not a relative time. */
export function formatElapsed(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`
}

export function initiatorLabel(initiatedBy: { username?: string; automated: boolean }) {
  if (initiatedBy.automated) return 'Automated sync'
  return initiatedBy.username || 'Unknown user'
}
