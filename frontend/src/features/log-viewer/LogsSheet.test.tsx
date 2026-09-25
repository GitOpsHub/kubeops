import { screen, render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../../components/ui/Toast'
import { mockLogsFetch } from '../../test/log-streams'
import { LogsSheet } from './LogsSheet'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('LogsSheet', () => {
  it('carries the chosen container into the full-screen link', async () => {
    mockLogsFetch({
      containers: [
        { name: 'app', image: 'app:1', init: false },
        { name: 'proxy', image: 'envoy:1', init: false },
      ],
    })
    render(
      <MemoryRouter>
        <ToastProvider>
          <LogsSheet
            onboardingId="onboarding-1"
            targetId="target-1"
            resource={{ kind: 'Pod', name: 'payments-api-abc', namespace: 'payments' }}
            onClose={() => {}}
          />
        </ToastProvider>
      </MemoryRouter>,
    )

    const link = screen.getByRole('link', { name: 'Open full screen' })
    // The default container is left to the full page, which picks the same one.
    expect(link.getAttribute('href')).not.toContain('container=')

    await userEvent
      .setup()
      .selectOptions(await screen.findByRole('combobox', { name: 'Container' }), 'proxy')
    await waitFor(() => expect(link.getAttribute('href')).toContain('container=proxy'))
  })
})
