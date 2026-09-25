import { describe, expect, it } from 'vitest'
import type { ArgoOperation, ArgoOperationResource } from '../../api/argo'
import { buildEvent, buildOperation, buildRevision } from '../../test/mock-api'
import { filterEvents, groupEvents } from './events'
import {
  currentPhaseLabel,
  deriveOperationSteps,
  formatElapsed,
  operationOutcome,
  operationProgress,
} from './operation-phases'
import { commitForDeploy } from './revision-history'
import { describeSync } from './sync-summary'
import { unifiedValuesDiff } from './values-diff'

function hook(type: string, phase: string): ArgoOperationResource {
  return {
    group: 'batch',
    version: 'v1',
    kind: 'Job',
    namespace: 'payments',
    name: `${type.toLowerCase()}-job`,
    status: phase === 'Failed' ? 'SyncFailed' : 'Synced',
    hookType: type,
    hookPhase: phase,
    syncPhase: type,
  }
}

const applied: ArgoOperationResource = {
  group: 'apps',
  version: 'v1',
  kind: 'Deployment',
  namespace: 'payments',
  name: 'payments-api',
  status: 'Synced',
  syncPhase: 'Sync',
}

function states(operation: ArgoOperation) {
  return deriveOperationSteps(operation).map((step) => `${step.label}:${step.state}`)
}

describe('deriveOperationSteps', () => {
  it.each([
    [
      'queued before any resource is applied',
      buildOperation({ phase: 'Running', resources: [] }),
      [
        'Queued:current',
        'PreSync:upcoming',
        'Sync:upcoming',
        'PostSync:upcoming',
        'Complete:upcoming',
      ],
    ],
    [
      'in a PreSync hook',
      buildOperation({ phase: 'Running', resources: [hook('PreSync', 'Running')] }),
      [
        'Queued:complete',
        'PreSync:current',
        'Sync:upcoming',
        'PostSync:upcoming',
        'Complete:upcoming',
      ],
    ],
    [
      'applying, with no PreSync hooks',
      buildOperation({ phase: 'Running', resources: [applied] }),
      [
        'Queued:complete',
        'PreSync:skipped',
        'Sync:current',
        'PostSync:upcoming',
        'Complete:upcoming',
      ],
    ],
    [
      'succeeded without hooks',
      buildOperation({ phase: 'Succeeded', resources: [applied] }),
      [
        'Queued:complete',
        'PreSync:skipped',
        'Sync:complete',
        'PostSync:skipped',
        'Succeeded:complete',
      ],
    ],
    [
      'failed in a PostSync hook',
      buildOperation({
        phase: 'Failed',
        resources: [hook('PreSync', 'Succeeded'), applied, hook('PostSync', 'Failed')],
      }),
      ['Queued:complete', 'PreSync:complete', 'Sync:complete', 'PostSync:failed', 'Failed:failed'],
    ],
    [
      'failed before anything rendered',
      buildOperation({ phase: 'Error', message: 'ComparisonError', resources: [] }),
      ['Queued:complete', 'PreSync:skipped', 'Sync:failed', 'PostSync:upcoming', 'Failed:failed'],
    ],
    [
      'terminated mid-sync',
      buildOperation({
        phase: 'Failed',
        message: 'Operation terminated',
        resources: [hook('PreSync', 'Succeeded'), applied],
      }),
      [
        'Queued:complete',
        'PreSync:complete',
        'Sync:failed',
        'PostSync:upcoming',
        'Terminated:failed',
      ],
    ],
  ])('%s', (_, operation, expected) => {
    expect(states(operation)).toEqual(expected)
  })

  it('summarises outcome, phase, and progress', () => {
    const running = buildOperation({
      phase: 'Running',
      resources: [hook('PreSync', 'Succeeded'), applied],
    })
    expect(operationOutcome(running)).toBe('running')
    expect(currentPhaseLabel(running)).toBe('Sync phase')
    expect(operationProgress(running)).toBeCloseTo(2.5 / 5)
    expect(currentPhaseLabel(buildOperation({ phase: 'Terminating' }))).toBe('Terminating')
    expect(operationOutcome(buildOperation({ phase: 'Succeeded' }))).toBe('succeeded')
  })
})

describe('formatElapsed', () => {
  it.each([
    [0, '0:00'],
    [42_000, '0:42'],
    [725_000, '12:05'],
    [3_723_000, '1:02:03'],
  ])('%i ms reads %s', (ms, expected) => {
    expect(formatElapsed(ms)).toBe(expected)
  })
})

describe('commitForDeploy', () => {
  const commits = [
    buildRevision({ sha: 'ccc3333aaaa0000', committedAt: '2026-09-20T12:00:00Z' }),
    buildRevision({ sha: 'bbb2222aaaa0000', committedAt: '2026-09-19T12:00:00Z' }),
  ]

  it.each([
    ['an exact full SHA', 'bbb2222aaaa0000', '2026-09-21T00:00:00Z', 'bbb2222aaaa0000'],
    ['an exact short SHA', 'ccc3333', null, 'ccc3333aaaa0000'],
    [
      'a HEAD that never touched the file',
      'fff9999000000000',
      '2026-09-19T18:00:00Z',
      'bbb2222aaaa0000',
    ],
    [
      'a deploy after the newest commit',
      'fff9999000000000',
      '2026-09-22T00:00:00Z',
      'ccc3333aaaa0000',
    ],
    ['a deploy older than the listed history', 'fff9999000000000', '2026-01-01T00:00:00Z', null],
    ['no SHA and no time', '', null, null],
  ])('matches %s', (_, sha, at, expected) => {
    expect(commitForDeploy(commits, sha, at)?.sha ?? null).toBe(expected)
  })
})

describe('events', () => {
  const warning = buildEvent({
    type: 'Warning',
    reason: 'BackOff',
    lastSeen: '2026-09-20T10:00:00Z',
  })
  const normal = buildEvent({
    reason: 'Synced',
    lastSeen: '2026-09-20T11:00:00Z',
    object: { kind: 'Application', name: 'payments-api' },
  })

  it('puts objects with warnings first, then the most recent', () => {
    expect(groupEvents([normal, warning]).map((group) => group.object.kind)).toEqual([
      'Pod',
      'Application',
    ])
  })

  it('filters by type, kind, and text', () => {
    const filters = { warningsOnly: false, kind: '', search: '' }
    expect(filterEvents([normal, warning], { ...filters, warningsOnly: true })).toEqual([warning])
    expect(filterEvents([normal, warning], { ...filters, kind: 'Application' })).toEqual([normal])
    expect(filterEvents([normal, warning], { ...filters, search: 'backoff' })).toEqual([warning])
  })
})

describe('describeSync', () => {
  it('reads options as consequences', () => {
    expect(
      describeSync(
        { prune: true, dryRun: false, force: true, applyOutOfSyncOnly: true },
        ['a', 'b', 'c'],
        'main',
      ),
    ).toBe(
      'Apply the latest commit on main to a, b, and c. Resources removed from Git are deleted. Only resources that are out of sync are applied. Resources that cannot be patched are deleted and recreated.',
    )
  })
})

describe('unifiedValuesDiff', () => {
  it('folds long unchanged runs around a change', () => {
    const before = Array.from({ length: 12 }, (_, index) => `key${index}: ${index}`).join('\n')
    const after = before.replace('key6: 6', 'key6: six')
    const lines = unifiedValuesDiff(before, after)
    expect(lines[0]).toEqual({ kind: 'gap', count: 3 })
    expect(lines.filter((line) => line.kind === 'removed')).toHaveLength(1)
    expect(lines.filter((line) => line.kind === 'added')).toHaveLength(1)
    expect(lines.at(-1)).toEqual({ kind: 'gap', count: 2 })
  })

  it('is empty when nothing changed', () => {
    expect(unifiedValuesDiff('a: 1\n', 'a: 1')).toEqual([])
  })
})
