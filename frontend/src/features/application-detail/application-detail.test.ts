import { describe, expect, it } from 'vitest'
import { buildTarget } from '../../test/mock-api'
import { failedTargetReasons } from './application-detail'

describe('failedTargetReasons', () => {
  it('names every failed cluster with the reason the API recorded', () => {
    expect(
      failedTargetReasons([
        buildTarget({ clusterName: 'prod-us-east', status: 'healthy', message: '' }),
        buildTarget({
          id: 'target-2',
          clusterName: 'demo-aws-spot',
          status: 'failed',
          message: 'Argo CD rejected the application (HTTP 403)',
        }),
        buildTarget({
          id: 'target-3',
          clusterName: 'gke-dev',
          status: 'failed',
          message: 'Argo CD could not be reached.',
        }),
      ]),
    ).toBe(
      'demo-aws-spot: Argo CD rejected the application (HTTP 403); gke-dev: Argo CD could not be reached',
    )
  })

  it('names a failed cluster that carries no reason, and stays empty when nothing failed', () => {
    expect(failedTargetReasons([buildTarget({ status: 'failed', message: undefined })])).toBe(
      'prod-us-east',
    )
    expect(failedTargetReasons([buildTarget({ status: 'healthy' })])).toBe('')
    expect(failedTargetReasons([])).toBe('')
  })
})
