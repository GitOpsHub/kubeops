import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildApplication,
  buildArgoStatus,
  buildRevision,
  buildTarget,
  mockAPI,
} from '../../test/mock-api'
import { renderApp } from '../../test/render'

afterEach(() => {
  vi.restoreAllMocks()
})

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()

const commits = [
  buildRevision({
    sha: 'ccc3333aaaa0000',
    message: 'Scale payments-api to 5 pods',
    committedAt: hoursAgo(1),
    current: true,
    url: 'https://github.com/GitOpsHub/payments-api/commit/ccc3333aaaa0000',
  }),
  buildRevision({
    sha: 'bbb2222aaaa0000',
    message: 'Bump image to 2.4.1',
    author: 'dev-a',
    url: 'https://github.com/GitOpsHub/payments-api/commit/bbb2222aaaa0000',
    committedAt: hoursAgo(5),
  }),
  buildRevision({
    sha: 'aaa1111aaaa0000',
    message: 'Onboard payments-api',
    committedAt: hoursAgo(24),
  }),
]

const values: Record<string, string> = {
  ccc3333aaaa0000: 'replicaCount: 5\nimage:\n  tag: 2.4.1\n',
  bbb2222aaaa0000: 'replicaCount: 2\nimage:\n  tag: 2.4.1\n',
  aaa1111aaaa0000: 'replicaCount: 2\nimage:\n  tag: 2.4.0\n',
}

function setup(overrides: Parameters<typeof mockAPI>[0] = {}) {
  const east = buildTarget({ id: 'target-1', clusterName: 'prod-us-east' })
  const eu = buildTarget({ id: 'target-2', clusterName: 'prod-eu', region: 'eu-west-1' })
  return mockAPI({
    applications: [buildApplication({ targets: [east, eu] })],
    revisions: commits,
    revisionValues: values,
    argoStatuses: {
      // East deployed the current file exactly.
      'target-1': buildArgoStatus(east, {
        history: [
          {
            id: 2,
            revisions: ['1.2.3', 'ccc3333aaaa0000'],
            deployStartedAt: hoursAgo(0.9),
            deployedAt: hoursAgo(0.9),
            initiatedBy: { automated: true },
          },
          {
            id: 1,
            revisions: ['1.2.3', 'aaa1111aaaa0000'],
            deployStartedAt: hoursAgo(23),
            deployedAt: hoursAgo(23),
            initiatedBy: { automated: true },
          },
        ],
      }),
      // EU last deployed a HEAD that never touched this file, after the
      // 2.4.1 bump but before the scale: it is running the bump.
      'target-2': buildArgoStatus(eu, {
        history: [
          {
            id: 7,
            revisions: ['1.2.3', 'fff9999000000000'],
            deployStartedAt: hoursAgo(3),
            deployedAt: hoursAgo(3),
            initiatedBy: { username: 'dev-b', automated: false },
          },
        ],
      }),
    },
    ...overrides,
  })
}

function revision(message: string) {
  const list = screen.getByRole('list', { name: 'Values revisions' })
  const item = within(list)
    .getAllByRole('listitem')
    .find((entry) => entry.textContent?.includes(message))
  if (!item) throw new Error(`No revision "${message}"`)
  return item
}

describe('RevisionHistory', () => {
  it('pins each cluster to the commit it runs and shows diffs', async () => {
    setup()
    renderApp('/applications/onboarding-1?tab=history')
    const user = userEvent.setup()

    await screen.findByRole('list', { name: 'Values revisions' })
    const current = revision('Scale payments-api to 5 pods')
    expect(within(current).getByText('Current')).toBeInTheDocument()
    expect(within(current).getByText('Live on prod-us-east')).toBeInTheDocument()
    expect(within(current).queryByRole('button', { name: /Roll back/ })).not.toBeInTheDocument()

    const bump = revision('Bump image to 2.4.1')
    expect(within(bump).getByText('Live on prod-eu')).toBeInTheDocument()
    expect(within(bump).getByText('dev-a')).toBeInTheDocument()
    expect(within(bump).getByRole('link', { name: 'bbb2222' })).toHaveAttribute(
      'href',
      'https://github.com/GitOpsHub/payments-api/commit/bbb2222aaaa0000',
    )

    const onboard = revision('Onboard payments-api')
    expect(within(onboard).getByText('Was on prod-us-east')).toBeInTheDocument()

    await user.click(within(bump).getByRole('button', { name: 'View diff for bbb2222' }))
    const diff = await within(bump).findByRole('figure', {
      name: 'Values diff from bbb2222 to the current commit',
    })
    expect(diff).toHaveTextContent('+1 −1')
    expect(diff).toHaveTextContent('Removed: replicaCount: 2')
    expect(diff).toHaveTextContent('Added: replicaCount: 5')
  })

  it('says how many values the server hid and diffs <redacted> lines as text', async () => {
    setup({
      revisionValues: {
        ...values,
        ccc3333aaaa0000: 'replicaCount: 5\ndb:\n  password: <redacted>\n',
        bbb2222aaaa0000: 'replicaCount: 2\ndb:\n  password: <redacted>\napiKey: <redacted>\n',
      },
      revisionRedactedKeys: {
        ccc3333aaaa0000: ['db.password'],
        bbb2222aaaa0000: ['db.password', 'apiKey'],
      },
    })
    renderApp('/applications/onboarding-1?tab=history')
    const user = userEvent.setup()

    await screen.findByRole('list', { name: 'Values revisions' })
    const bump = revision('Bump image to 2.4.1')
    await user.click(within(bump).getByRole('button', { name: 'View diff for bbb2222' }))
    const diff = await within(bump).findByRole('figure', {
      name: 'Values diff from bbb2222 to the current commit',
    })
    expect(within(diff).getByRole('note')).toHaveTextContent('2 secret-looking values are hidden')
    expect(diff).toHaveTextContent('Removed: apiKey: <redacted>')
    expect(diff).toHaveTextContent('password: <redacted>')
    expect(diff).toHaveTextContent('+1 −2')
  })

  it('rolls back through Git after the diff is reviewed and the name typed', async () => {
    const { fetchMock, state } = setup()
    renderApp('/applications/onboarding-1?tab=history')
    const user = userEvent.setup()

    await screen.findByRole('list', { name: 'Values revisions' })
    await user.click(
      within(revision('Onboard payments-api')).getByRole('button', {
        name: 'Roll back to aaa1111',
      }),
    )

    const dialog = await screen.findByRole('dialog', { name: 'Roll back payments-api to aaa1111?' })
    const preview = await within(dialog).findByRole('figure', {
      name: 'Values changes from rolling back to aaa1111',
    })
    expect(preview).toHaveTextContent('Current (ccc3333) → aaa1111')
    expect(preview).toHaveTextContent('Removed: replicaCount: 5')
    expect(preview).toHaveTextContent('Added: tag: 2.4.0')
    expect(dialog).toHaveTextContent('A new commit on main restores prod/us-east-1/values.yaml')
    expect(dialog).toHaveTextContent(
      'Automated sync applies it to 2 clusters: prod-us-east, prod-eu.',
    )
    expect(dialog).toHaveTextContent(
      'Not rolled back: the chart revision (global-app 1.2.3) and the shared root values.yaml.',
    )

    // Production asks for the name back before arming the button.
    const confirm = within(dialog).getByRole('button', { name: 'Roll back' })
    expect(confirm).toBeDisabled()
    await user.type(within(dialog).getByRole('textbox'), 'payments-api')
    await user.click(confirm)

    await waitFor(() => expect(state.rollbacks).toEqual(['aaa1111aaaa0000']))
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/rollback'))
    expect(call?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commitSha: 'aaa1111aaaa0000' }),
    })
    expect(
      await screen.findByText(
        'Rolled back prod-us-east-1 values to aaa1111. Argo CD is syncing 2 clusters.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('dialog', { name: 'Roll back payments-api to aaa1111?' }),
    ).not.toBeInTheDocument()
  })

  it('keeps history but hides rollback when console mutations are off', async () => {
    setup({ consoleMutations: false })
    renderApp('/applications/onboarding-1?tab=history')

    await screen.findByRole('list', { name: 'Values revisions' })
    expect(await screen.findByRole('note')).toHaveTextContent(/Rollback is turned off/)
    expect(screen.queryByRole('button', { name: /Roll back to/ })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /View diff for/ })).toHaveLength(2)
  })

  it('explains when the values repository is not configured', async () => {
    setup({ revisionsStatus: 422 })
    renderApp('/applications/onboarding-1?tab=history')

    expect(await screen.findByText('Values history is unavailable')).toBeInTheDocument()
    expect(screen.getByText(/the values repository is not configured/)).toBeInTheDocument()
  })
})
