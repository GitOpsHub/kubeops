import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { buildCluster, mockAPI } from '../../test/mock-api'
import { renderApp } from '../../test/render'
import { draftStorageKey, serverErrorField } from './onboarding-wizard'

type User = ReturnType<typeof userEvent.setup>

beforeEach(() => window.sessionStorage.clear())

afterEach(() => {
  vi.restoreAllMocks()
})

const clusters = [
  buildCluster('active', { id: 'east-1', name: 'prod-use1', location: 'us-east-1' }),
  buildCluster('active', { id: 'east-2', name: 'prod-use2', location: 'us-east-2b' }),
  buildCluster('active', {
    id: 'local',
    name: 'docker-desktop',
    provider: 'docker',
    sourceId: 'local',
    sourceName: 'Local',
    location: 'local',
  }),
]

async function next(user: User) {
  await user.click(screen.getByRole('button', { name: 'Next' }))
}

async function openWizard() {
  renderApp('/applications/new')
  const user = userEvent.setup()
  await screen.findByRole('heading', { name: 'Onboard an application' })
  return user
}

/** Names the app, keeps the default scope, and stops on the Targets step. */
async function reachTargets(user: User) {
  await user.type(screen.getByLabelText('Application name'), 'payments-api')
  await next(user)
  await next(user)
  await screen.findByRole('heading', { name: 'Pick target clusters' })
}

function clusterCheckboxes() {
  return screen.queryAllByRole('checkbox').map((box) => box.getAttribute('aria-label'))
}

describe('onboarding wizard targets', () => {
  it('lists only clusters in the chosen region until every cluster is shown', async () => {
    mockAPI({ clusters })
    const user = await openWizard()
    await reachTargets(user)

    await screen.findByRole('checkbox', { name: 'Select prod-use1' })
    expect(clusterCheckboxes()).toEqual(['Select prod-use1'])
    expect(screen.getByText('1 of 3 clusters in us-east-1')).toBeInTheDocument()

    await user.click(screen.getByRole('switch', { name: 'Show all clusters' }))
    expect(clusterCheckboxes()).toEqual([
      'Select prod-use1',
      'Select prod-use2',
      'Select docker-desktop',
    ])
    // Grouped by provider, EKS before Docker.
    const table = screen.getByRole('table', { name: 'Target clusters' })
    const groups = within(table)
      .getAllByRole('columnheader')
      .filter((cell) => cell.getAttribute('scope') === 'colgroup')
      .map((cell) => cell.textContent)
    expect(groups[0]).toMatch(/^EKS/)
    expect(groups[1]).toMatch(/^Docker/)

    await user.type(screen.getByRole('searchbox', { name: 'Search clusters' }), 'docker')
    expect(clusterCheckboxes()).toEqual(['Select docker-desktop'])
  })

  it('follows a region change back on the Scope step, zones included', async () => {
    mockAPI({ clusters })
    const user = await openWizard()
    await reachTargets(user)
    await user.click(await screen.findByRole('checkbox', { name: 'Select prod-use1' }))
    expect(screen.getByText('1 selected')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Back' }))
    await user.selectOptions(screen.getByLabelText('Region'), 'us-east-2')
    await next(user)

    await screen.findByRole('checkbox', { name: 'Select prod-use2' })
    expect(clusterCheckboxes()).toEqual(['Select prod-use2'])
    // The earlier pick stays selected even though the filter hides it.
    expect(screen.getByText('1 selected')).toBeInTheDocument()
    expect(screen.getByText('(1 not shown)')).toBeInTheDocument()
  })

  it('offers every region when the chosen one has no clusters', async () => {
    mockAPI({ clusters: [clusters[2]] })
    const user = await openWizard()
    await reachTargets(user)

    expect(await screen.findByText('No clusters in us-east-1')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Include every region' }))
    expect(screen.getByRole('switch', { name: 'Show all clusters' })).toBeChecked()
    expect(clusterCheckboxes()).toEqual(['Select docker-desktop'])
  })
})

describe('onboarding wizard validation', () => {
  it('keeps the operator on a step until its fields are valid', async () => {
    mockAPI()
    const user = await openWizard()

    await next(user)
    const name = screen.getByLabelText('Application name')
    expect(name).toHaveAttribute('aria-invalid', 'true')
    expect(name).toHaveAccessibleDescription(expect.stringContaining('Enter an application name.'))
    expect(name).toHaveFocus()
    expect(screen.getByRole('heading', { name: 'Name the application' })).toBeInTheDocument()

    await user.type(name, 'Payments')
    // Editing clears the error until the next attempt.
    expect(name).not.toHaveAttribute('aria-invalid')
    await next(user)
    expect(name).toHaveAccessibleDescription(expect.stringContaining('Use lowercase letters'))

    await user.clear(name)
    await user.type(name, 'payments-api')
    await next(user)
    const heading = await screen.findByRole('heading', { name: 'Choose where it belongs' })
    expect(heading).toHaveFocus()
    expect(screen.getByText('Step 2 of 5')).toBeInTheDocument()
  })

  it('checks the region override as YAML before review', async () => {
    mockAPI()
    const user = await openWizard()
    await reachTargets(user)
    await user.click(await screen.findByRole('checkbox'))
    await next(user)

    const editor = screen.getByLabelText('us-east-1 values override')
    expect(screen.getByText('Empty — the chart defaults apply unchanged.')).toBeInTheDocument()
    await user.type(editor, '- one')
    expect(editor).toHaveAttribute('aria-invalid', 'true')
    expect(
      screen.getByText('us-east-1 values must contain a top-level YAML mapping.'),
    ).toBeInTheDocument()
    await next(user)
    expect(screen.getByRole('heading', { name: 'Adjust values' })).toBeInTheDocument()

    await user.clear(editor)
    await user.type(editor, 'replicaCount: 3')
    expect(screen.getByText(/Valid YAML mapping · 1 top-level key/)).toBeInTheDocument()
    await next(user)
    expect(await screen.findByRole('heading', { name: 'Review and onboard' })).toBeInTheDocument()
    expect(screen.getByText('Chart defaults + 1 region override (us-east-1)')).toBeInTheDocument()
  })

  it('returns to a completed step from the progress rail', async () => {
    mockAPI()
    const user = await openWizard()
    await reachTargets(user)

    const progress = screen.getByRole('list', { name: 'Progress' })
    await user.click(within(progress).getByRole('button', { name: /Application/ }))
    expect(await screen.findByRole('heading', { name: 'Name the application' })).toHaveFocus()
    expect(screen.getByLabelText('Application name')).toHaveValue('payments-api')
  })
})

describe('onboarding wizard accessibility', () => {
  it('has no axe violations on the targets and review steps', async () => {
    mockAPI({ clusters })
    const user = await openWizard()
    await reachTargets(user)
    await user.click(await screen.findByRole('checkbox'))
    expect(await axe(document.body)).toHaveNoViolations()

    await next(user)
    await next(user)
    await screen.findByRole('heading', { name: 'Review and onboard' })
    expect(await axe(document.body)).toHaveNoViolations()
  })
})

describe('onboarding wizard draft', () => {
  it('restores a draft from this session and can start over', async () => {
    window.sessionStorage.setItem(
      draftStorageKey,
      JSON.stringify({
        name: 'orders-api',
        environment: 'qa',
        region: 'us-east-1',
        clusterIds: [],
        regionValues: {},
        showAllClusters: false,
        step: 'values',
      }),
    )
    mockAPI()
    const user = await openWizard()

    expect(screen.getByText('Draft restored')).toBeInTheDocument()
    // No target was chosen, so the draft resumes at Targets rather than Values.
    expect(screen.getByRole('heading', { name: 'Pick target clusters' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByLabelText('Environment')).toHaveValue('qa')

    await user.click(screen.getByRole('button', { name: 'Start over' }))
    expect(screen.getByRole('heading', { name: 'Name the application' })).toBeInTheDocument()
    expect(screen.getByLabelText('Application name')).toHaveValue('')
    expect(window.sessionStorage.getItem(draftStorageKey)).toBeNull()
  })

  it('saves progress as the operator types and clears it once onboarded', async () => {
    mockAPI()
    const user = await openWizard()
    await reachTargets(user)
    expect(JSON.parse(window.sessionStorage.getItem(draftStorageKey) ?? '{}')).toMatchObject({
      name: 'payments-api',
      step: 'targets',
    })

    await user.click(await screen.findByRole('checkbox'))
    await next(user)
    await next(user)
    await user.click(screen.getByRole('button', { name: 'Onboard' }))

    expect(await screen.findByText('payments-api onboarding started')).toBeInTheDocument()
    expect(window.sessionStorage.getItem(draftStorageKey)).toBeNull()
  })
})

describe('onboarding wizard server errors', () => {
  async function submitWith(status: number, error: string) {
    const { fetchMock } = mockAPI()
    const fallback = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (request, init) => {
      if (init?.method === 'POST') return Response.json({ error }, { status })
      return fallback(request, init)
    })
    const user = await openWizard()
    await reachTargets(user)
    await user.click(await screen.findByRole('checkbox'))
    await next(user)
    await next(user)
    await user.click(screen.getByRole('button', { name: 'Onboard' }))
    return user
  }

  it('sends a conflict on the name back to the Application step', async () => {
    const user = await submitWith(
      409,
      'payments-api is already onboarded in namespace payments-api-dev-us-east-1; sync it instead, or offboard it first',
    )

    const name = await screen.findByLabelText('Application name')
    await waitFor(() => expect(name).toHaveFocus())
    expect(name).toHaveAttribute('aria-invalid', 'true')
    expect(name).toHaveAccessibleDescription(
      expect.stringContaining('Payments-api is already onboarded'),
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    await user.type(name, '-v2')
    expect(name).not.toHaveAttribute('aria-invalid')
  })

  it('sends an Argo CD target problem back to the Targets step', async () => {
    await submitWith(422, 'cluster "prod-us-east" does not have an Argo CD target configured')

    expect(await screen.findByRole('heading', { name: 'Pick target clusters' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Cluster "prod-us-east" does not have an Argo CD target configured.',
    )
  })

  it('keeps unrecognised failures as a form-level alert on review', async () => {
    await submitWith(502, 'GitHub could not create the values repository')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'GitHub could not create the values repository',
    )
    expect(screen.getByRole('heading', { name: 'Review and onboard' })).toBeInTheDocument()
  })
})

describe('serverErrorField', () => {
  it.each([
    [422, 'name must be a lowercase DNS label', 'name'],
    [
      422,
      'application name plus environment and region must fit in a 63-character DNS label',
      'name',
    ],
    [409, 'payments-api is already onboarded in namespace x; sync it instead', 'name'],
    [422, 'environment must be dev, qa, or prod', 'environment'],
    [422, 'region must be us-east-1 or us-east-2', 'region'],
    [422, 'at least one target cluster is required', 'clusters'],
    [422, 'removed clusters cannot receive applications', 'clusters'],
    [422, 'us-east-1 values must contain valid YAML', 'values'],
    [422, 'valuesYaml must contain valid YAML', null],
    [422, 'application onboarding is not configured', null],
    [500, 'name must be a lowercase DNS label', null],
  ])('%i %s → %s', (status, message, field) => {
    expect(serverErrorField(status, message)).toBe(field)
  })
})
