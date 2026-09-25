import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PodLogEntry } from '../../api/argo'
import { ToastProvider } from '../../components/ui/Toast'
import { mockLogsFetch, settle, stubAnimationFrames } from '../../test/log-streams'
import { LogViewer, type LogViewerProps } from './LogViewer'

afterEach(() => {
  vi.restoreAllMocks()
})

function renderViewer(props: Partial<LogViewerProps> = {}) {
  return render(
    <ToastProvider>
      <LogViewer
        onboardingId="onboarding-1"
        targetId="target-1"
        resource={{ kind: 'Pod', name: 'payments-api-abc', namespace: 'payments' }}
        {...props}
      />
    </ToastProvider>,
  )
}

/** Opens a viewer and delivers the given lines through one rendered frame. */
async function viewerWith(entries: PodLogEntry[], props: Partial<LogViewerProps> = {}) {
  const frames = stubAnimationFrames()
  const fetch = mockLogsFetch()
  const view = renderViewer(props)
  await act(settle)
  await act(async () => {
    if (entries.length) fetch.streams[0].push(...entries)
    await settle()
  })
  act(() => frames.run())
  return { ...view, ...fetch, frames }
}

const line = (content: string, second = 0, podName = 'payments-api-abc'): PodLogEntry => ({
  timestamp: `2026-08-04T12:00:${String(second).padStart(2, '0')}Z`,
  podName,
  content,
})

describe('LogViewer', () => {
  it('renders a whole batch in one animation frame', async () => {
    const frames = stubAnimationFrames()
    const { streams } = mockLogsFetch()
    renderViewer()
    await act(settle)
    expect(screen.getByText('Waiting for log lines…')).toBeInTheDocument()

    await act(async () => {
      streams[0].push(line('one'))
      streams[0].push(line('two', 1))
      streams[0].push(line('three', 2))
      await settle()
    })
    expect(screen.queryByRole('log')).not.toBeInTheDocument()
    expect(frames.pending).toBe(1)

    act(() => frames.run())
    const log = screen.getByRole('log', { name: 'Live logs for payments-api-abc' })
    expect(log).toHaveAttribute('aria-live', 'off')
    expect(log).toHaveTextContent(/one.*two.*three/)
    expect(screen.getByText(/Showing the latest 3 lines/)).toBeInTheDocument()
    expect(document.querySelector('.log-status')).toHaveTextContent('Live')
  })

  it('highlights search matches and steps through them', async () => {
    await viewerWith([
      line('GET /health 200'),
      line('ERROR db down', 1),
      line('GET /Health 500', 2),
    ])
    const user = userEvent.setup()
    const log = screen.getByRole('log')

    await user.type(screen.getByRole('searchbox', { name: 'Search logs' }), 'health')
    const marks = log.querySelectorAll('mark')
    expect([...marks].map((mark) => mark.textContent)).toEqual(['health', 'Health'])
    expect(screen.getByText('1 of 2')).toBeInTheDocument()
    expect(marks[0]).toHaveClass('is-active')

    await user.click(screen.getByRole('button', { name: 'Next match' }))
    expect(screen.getByText('2 of 2')).toBeInTheDocument()
    expect(log.querySelectorAll('mark')[1]).toHaveClass('is-active')

    // Enter wraps around to the first match.
    await user.type(screen.getByRole('searchbox', { name: 'Search logs' }), '{Enter}')
    expect(screen.getByText('1 of 2')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Match case' }))
    expect(screen.getByText('1 of 1')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Regular expression' }))
    await user.clear(screen.getByRole('searchbox', { name: 'Search logs' }))
    await user.type(screen.getByRole('searchbox', { name: 'Search logs' }), '[25]00')
    expect(screen.getByText('1 of 2')).toBeInTheDocument()
  })

  it('filters by level and counts each level', async () => {
    await viewerWith([
      line('ERROR db down'),
      line('WARN slow query', 1),
      line('{"level":"error","msg":"retry failed"}', 2),
      line('plain line', 3),
    ])
    const user = userEvent.setup()

    const errors = screen.getByRole('button', { name: 'Error, 2 lines' })
    expect(screen.getByRole('button', { name: 'Warn, 1 lines' })).toBeInTheDocument()
    await user.click(errors)
    expect(errors).toHaveAttribute('aria-pressed', 'true')

    const log = screen.getByRole('log')
    expect(log).toHaveTextContent('ERROR db down')
    expect(log).toHaveTextContent('retry failed')
    expect(log).not.toHaveTextContent('slow query')
    expect(log).not.toHaveTextContent('plain line')
    expect(screen.getByText('2 at selected levels')).toBeInTheDocument()
  })

  it('downloads the buffer as a .log file built in the browser', async () => {
    const createObjectURL = vi.fn((blob: Blob) => {
      void blob
      return 'blob:logs'
    })
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      expect(this.download).toMatch(/^payments-api-abc-.*\.log$/)
      expect(this.href).toBe('blob:logs')
    })

    await viewerWith([line('server started'), line('GET /health 200', 1)])
    await userEvent.setup().click(screen.getByRole('button', { name: 'Download logs' }))

    expect(click).toHaveBeenCalledTimes(1)
    const blob = createObjectURL.mock.calls[0][0]
    expect(await blob.text()).toBe(
      '2026-08-04T12:00:00Z [payments-api-abc] server started\n' +
        '2026-08-04T12:00:01Z [payments-api-abc] GET /health 200',
    )
  })

  it('pauses following when scrolled up and counts new lines until the reader returns', async () => {
    const { streams, frames } = await viewerWith([line('one'), line('two', 1)])
    const log = screen.getByRole('log')
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1_000 })
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 200 })
    Object.defineProperty(log, 'scrollTop', { configurable: true, writable: true, value: 800 })
    fireEvent.scroll(log)
    const follow = screen.getByRole('button', { name: 'Follow' })
    expect(follow).toHaveAttribute('aria-pressed', 'true')

    log.scrollTop = 300
    fireEvent.scroll(log)
    expect(follow).toHaveAttribute('aria-pressed', 'false')

    await act(async () => {
      streams[0].push(line('three', 2), line('four', 3), line('five', 4))
      await settle()
    })
    act(() => frames.run())
    const pill = screen.getByRole('button', { name: /3 new lines/ })

    await userEvent.setup().click(pill)
    expect(follow).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('button', { name: /new lines/ })).not.toBeInTheDocument()
    expect(log.scrollTop).toBe(1_000)
  })

  it('jumps back to the newest line with End', async () => {
    const { streams, frames } = await viewerWith([line('one')])
    await userEvent.setup().click(screen.getByRole('button', { name: 'Follow' }))
    await act(async () => {
      streams[0].push(line('two', 1))
      await settle()
    })
    act(() => frames.run())
    expect(screen.getByRole('button', { name: /1 new line/ })).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('log'), { key: 'End' })
    expect(screen.getByRole('button', { name: 'Follow' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('picks a container and restarts the stream on change', async () => {
    const { requests } = mockLogsFetch({
      containers: [
        { name: 'migrate', image: 'migrate:1', init: true },
        { name: 'app', image: 'app:1', init: false },
        { name: 'proxy', image: 'envoy:1', init: false },
      ],
    })
    renderViewer()
    const select = await screen.findByRole('combobox', { name: 'Container' })
    // Init containers are listed, but the main container is the default.
    expect(select).toHaveValue('app')
    await waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0].searchParams.get('container')).toBe('app')

    await userEvent.setup().selectOptions(select, 'proxy')
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1].searchParams.get('container')).toBe('proxy')
  })

  it('hides the container picker for a single container and shows the pod column for workloads', async () => {
    mockLogsFetch({ containers: [{ name: 'app', image: 'app:1', init: false }] })
    renderViewer({ resource: { kind: 'Deployment', name: 'payments-api' } })
    await act(settle)
    expect(screen.queryByRole('combobox', { name: 'Container' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Pod column' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('restarts with since, previous, and a server-side filter', async () => {
    const { requests } = await viewerWith([])
    const user = userEvent.setup()

    await user.selectOptions(screen.getByRole('combobox', { name: 'Since' }), 'Last 5 minutes')
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1].searchParams.get('sinceSeconds')).toBe('300')

    await user.click(screen.getByRole('button', { name: 'Previous container' }))
    await waitFor(() => expect(requests).toHaveLength(3))
    expect(requests[2].searchParams.get('previous')).toBe('true')

    await user.click(screen.getByRole('button', { name: 'Server filter' }))
    await user.type(screen.getByRole('searchbox', { name: 'Search logs' }), 'timeout')
    await waitFor(() => expect(requests).toHaveLength(4))
    expect(requests[3].searchParams.get('filter')).toBe('timeout')
  })

  it('explains a 403 as missing log access in Argo CD', async () => {
    mockLogsFetch({ status: 403 })
    renderViewer()
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('Log access isn’t configured')).toBeInTheDocument()
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    expect(document.querySelector('.log-status')).toHaveTextContent('Error')
  })

  it('clears the screen without stopping the stream', async () => {
    const { streams, frames } = await viewerWith([line('one'), line('two', 1)])
    await userEvent.setup().click(screen.getByRole('button', { name: 'Clear' }))
    expect(screen.queryByRole('log')).not.toBeInTheDocument()
    expect(screen.getByText(/Showing the latest 0 lines/)).toBeInTheDocument()

    await act(async () => {
      streams[0].push(line('three', 2))
      await settle()
    })
    act(() => frames.run())
    expect(screen.getByRole('log')).toHaveTextContent('three')
    expect(screen.getByRole('log')).not.toHaveTextContent('one')
  })

  it('virtualises long buffers', async () => {
    const entries = Array.from({ length: 1_000 }, (_, index) => line(`line ${index}`))
    await viewerWith(entries)
    // jsdom has no layout, so only a window of rows (or none) is rendered.
    expect(screen.getByRole('log').querySelectorAll('.log-row').length).toBeLessThan(1_000)
    expect(screen.getByText(/Showing the latest 1,000 lines/)).toBeInTheDocument()
  })
})
