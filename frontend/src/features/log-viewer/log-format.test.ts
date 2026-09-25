import { describe, expect, it } from 'vitest'
import { podNamePrefix, shortPodName } from './log-format'

describe('pod labels', () => {
  it.each([
    {
      name: 'pods of one ReplicaSet read by their random suffix',
      pods: ['payments-api-7d9f8c6b5-x7k2p', 'payments-api-7d9f8c6b5-q4m8z'],
      fallback: 'payments-api-',
      labels: ['x7k2p', 'q4m8z'],
    },
    {
      name: 'a rollout across two ReplicaSets keeps the hash that separates them',
      pods: ['payments-api-7d9f8c6b5-x7k2p', 'payments-api-5c4b3a291-q4m8z'],
      fallback: 'payments-api-',
      labels: ['7d9f8c6b5-x7k2p', '5c4b3a291-q4m8z'],
    },
    {
      name: 'StatefulSet ordinals',
      pods: ['web-0', 'web-1', 'web-2'],
      fallback: 'web-',
      labels: ['0', '1', '2'],
    },
    {
      name: 'a shared prefix is cut back to a dash, never mid-token',
      pods: ['api-abc12', 'api-abd34'],
      fallback: '',
      labels: ['abc12', 'abd34'],
    },
    {
      name: 'a single pod strips the workload name',
      pods: ['payments-api-7d9f8c6b5-x7k2p', 'payments-api-7d9f8c6b5-x7k2p'],
      fallback: 'payments-api-',
      labels: ['7d9f8c6b5-x7k2p', '7d9f8c6b5-x7k2p'],
    },
    {
      name: 'a single pod without a workload name is shown whole',
      pods: ['payments-api-abc'],
      fallback: '',
      labels: ['payments-api-abc'],
    },
    {
      name: 'unrelated pods keep the tail of long names',
      pods: ['frontend-6d8f9c7b44-abcde', 'worker'],
      fallback: '',
      labels: ['…d8f9c7b44-abcde', 'worker'],
    },
    { name: 'no pods', pods: [], fallback: 'api-', labels: [] },
  ])('$name', ({ pods, fallback, labels }) => {
    const prefix = podNamePrefix(pods, fallback)
    expect(pods.map((pod) => shortPodName(pod, prefix))).toEqual(labels)
  })

  it('never exceeds the maximum label length', () => {
    expect(shortPodName('a'.repeat(40), '', 10)).toHaveLength(10)
  })
})
