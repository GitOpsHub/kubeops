import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildResource, mockAPI } from '../../test/mock-api'
import { ResourceManifestModal } from './ResourceManifestModal'
import { ResourceTable } from './ResourceTable'

function CurrentURL() {
  const location = useLocation()
  return <output aria-label="Current URL">{location.pathname + location.search}</output>
}

describe('resource manifest modal', () => {
  afterEach(() => vi.restoreAllMocks())

  it('shows numbered, wrappable, copyable YAML and links to the resource events', async () => {
    mockAPI({ manifest: '{"kind":"Deployment","metadata":{"name":"payments-api"}}' })
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/applications/onboarding-1?target=target-1']}>
        <Routes>
          <Route
            path="/applications/:id"
            element={
              <>
                <ResourceManifestModal
                  node={buildResource({ uid: 'uid-dep', syncStatus: 'OutOfSync' })}
                  onboardingId="onboarding-1"
                  targetId="target-1"
                  onClose={onClose}
                  onDelete={vi.fn()}
                />
                <CurrentURL />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    )

    const modal = await screen.findByRole('dialog')
    const yaml = await within(modal).findByLabelText('YAML for payments-api')
    expect(yaml).toHaveTextContent('kind: Deployment')
    expect(yaml.querySelectorAll('.code-ln')[0]).toHaveAttribute('aria-hidden', 'true')
    expect(within(modal).getByText('YAML · 4 lines')).toBeInTheDocument()
    expect(within(modal).getByText('Out of Sync')).toBeInTheDocument()
    expect(within(modal).getAllByRole('button', { name: 'Close' })).toHaveLength(1)
    expect(within(modal).getByRole('button', { name: 'Delete resource' })).toBeInTheDocument()
    expect(within(modal).getByRole('button', { name: 'Copy YAML' })).toBeInTheDocument()

    const wrap = within(modal).getByRole('button', { name: 'Wrap lines' })
    expect(wrap).toHaveAttribute('aria-pressed', 'false')
    await user.click(wrap)
    expect(wrap).toHaveAttribute('aria-pressed', 'true')

    await user.click(within(modal).getByRole('link', { name: 'View events' }))
    const landed = new URL(screen.getByLabelText('Current URL').textContent ?? '', 'http://x')
    expect(landed.pathname).toBe('/applications/onboarding-1')
    expect(Object.fromEntries(landed.searchParams)).toMatchObject({
      tab: 'events',
      target: 'target-1',
      uid: 'uid-dep',
      kind: 'Deployment',
      name: 'payments-api',
    })
    expect(onClose).toHaveBeenCalled()
  })
})

describe('resource table', () => {
  it('uses canonical labels and offers Info, Logs, and Delete per row', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(
      <ResourceTable
        nodes={[
          buildResource({ uid: 'dep', syncStatus: 'OutOfSync' }),
          buildResource({
            uid: 'cm',
            group: '',
            kind: 'ConfigMap',
            name: 'payments-config',
            syncStatus: '',
          }),
        ]}
        onSelect={onSelect}
        onDelete={vi.fn()}
        onLogs={vi.fn()}
      />,
    )

    const row = screen
      .getByRole('button', { name: 'Info for Deployment payments-api' })
      .closest('tr')!
    expect(within(row).getByText('Out of Sync')).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: 'Logs for Deployment payments-api' }))
    expect(within(row).getByRole('button', { name: 'Delete Deployment payments-api' }))
    // A ConfigMap has no logs.
    expect(
      screen.queryByRole('button', { name: 'Logs for ConfigMap payments-config' }),
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Info for Deployment payments-api' }))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ uid: 'dep' }))
    expect(screen.getByText('2 resources')).toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Kind' }), 'ConfigMap')
    expect(screen.getByText('1 of 2 resources')).toBeInTheDocument()
  })
})
