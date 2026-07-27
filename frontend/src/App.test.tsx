import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'

describe('App', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows the onboarding workflow and a connected API', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          service: 'kubeops-api',
          status: 'ok',
          environment: 'test',
        }),
        { status: 200 },
      ),
    )

    render(<App />)

    expect(
      screen.getByRole('heading', {
        name: /ship applications with a clear path to the cluster/i,
      }),
    ).toBeInTheDocument()
    expect(await screen.findByText('API connected')).toBeInTheDocument()
  })

  it('reports when the API is unavailable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))

    render(<App />)

    expect(await screen.findByText('API unavailable')).toBeInTheDocument()
  })
})
