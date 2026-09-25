import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { BarList } from './BarList'
import { Donut } from './Donut'
import { Sparkline } from './Sparkline'
import { StackedBar } from './StackedBar'
import { TimeSeries, type TimeSeriesSeries } from './TimeSeries'

function renderInRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>)
}

/** Every path and coordinate attribute, to prove no NaN reached the SVG. */
function geometry(container: HTMLElement) {
  return [...container.querySelectorAll('path, circle, rect, line, text')]
    .flatMap((element) =>
      ['d', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'width', 'height'].map((name) =>
        element.getAttribute(name),
      ),
    )
    .filter((value): value is string => value !== null)
    .join(' ')
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Sparkline', () => {
  it('names the trend it draws', () => {
    render(<Sparkline values={[4, 5, null, 6]} label="Fleet size" />)
    expect(
      screen.getByRole('img', { name: 'Fleet size. From 4 to 6; low 4, high 6.' }),
    ).toBeInTheDocument()
  })

  it.each([
    { values: [], summary: 'No data.' },
    { values: [null, null], summary: 'No data.' },
    { values: [7], summary: '7.' },
    { values: [3, 3, 3], summary: 'From 3 to 3; low 3, high 3.' },
  ])('draws $values without NaN', ({ values, summary }) => {
    const { container } = render(<Sparkline values={values} label="Trend" />)
    expect(screen.getByRole('img', { name: `Trend. ${summary}` })).toBeInTheDocument()
    expect(geometry(container)).not.toMatch(/NaN|Infinity/)
  })
})

describe('Donut', () => {
  const segments = [
    {
      id: 'aws',
      label: 'EKS',
      value: 1,
      color: 'chart-1' as const,
      href: '/clusters?provider=aws',
    },
    { id: 'azure', label: 'AKS', value: 3, color: 'chart-2' as const },
  ]

  it('uses its legend as the accessible data, with links where given', async () => {
    const { container } = renderInRouter(
      <Donut segments={segments} label="Clusters by provider" center={{ value: 4 }} />,
    )
    const figure = screen.getByRole('figure', { name: 'Clusters by provider' })
    expect(within(figure).getByRole('link', { name: /EKS/ })).toHaveAttribute(
      'href',
      '/clusters?provider=aws',
    )
    expect(within(figure).getByText('AKS')).toBeInTheDocument()
    expect(within(figure).getByText('75%')).toBeInTheDocument()
    expect(within(figure).queryByRole('table')).not.toBeInTheDocument()
    expect(await axe(container)).toHaveNoViolations()
  })

  it('falls back to a hidden table without a legend', () => {
    renderInRouter(<Donut segments={segments} label="Providers" legend={false} />)
    const table = screen.getByRole('table', { name: 'Providers' })
    expect(within(table).getByRole('rowheader', { name: 'AKS' })).toBeInTheDocument()
    expect(within(table).getByRole('cell', { name: '3' })).toBeInTheDocument()
  })

  it('draws an empty or broken set without NaN', () => {
    const { container } = renderInRouter(
      <Donut
        segments={[
          { id: 'a', label: 'A', value: 0 },
          { id: 'b', label: 'B', value: Number.NaN },
        ]}
        label="Nothing"
      />,
    )
    expect(geometry(container)).not.toMatch(/NaN|Infinity/)
    expect(container.querySelectorAll('.donut-segment')).toHaveLength(0)
  })
})

describe('StackedBar', () => {
  const segments = [
    { id: 'healthy', label: 'Healthy', value: 3, tone: 'ok' as const, href: '/a?status=healthy' },
    { id: 'failed', label: 'Failed', value: 1, tone: 'err' as const },
    { id: 'partial', label: 'Partial', value: 0, tone: 'warn' as const },
  ]

  it('lists every segment, empty ones included, and draws only the non-empty', async () => {
    const { container } = renderInRouter(<StackedBar segments={segments} label="Releases" />)
    const figure = screen.getByRole('figure', { name: 'Releases' })
    expect(within(figure).getByRole('link', { name: /Healthy/ })).toHaveAttribute(
      'href',
      '/a?status=healthy',
    )
    expect(within(figure).getByText('Partial')).toBeInTheDocument()
    expect(container.querySelectorAll('.stacked-bar-segment')).toHaveLength(2)
    expect(await axe(container)).toHaveNoViolations()
  })

  it('shows the hovered segment in a tooltip', () => {
    const { container } = renderInRouter(<StackedBar segments={segments} label="Releases" />)
    fireEvent.pointerEnter(container.querySelectorAll('.stacked-bar-segment')[1])
    expect(container.querySelector('.chart-tooltip')).toHaveTextContent('1Failed · 25%')
  })

  it('stays out of the accessibility tree when decorative', () => {
    const { container } = renderInRouter(
      <StackedBar segments={segments} label="Releases" decorative />,
    )
    expect(screen.queryByRole('figure')).not.toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true')
  })
})

describe('BarList', () => {
  it('prints each value beside its bar', () => {
    renderInRouter(
      <BarList
        label="Top namespaces"
        items={[
          { id: 'a', label: 'payments', value: 12, href: '/ns/payments' },
          { id: 'b', label: 'billing', value: 0 },
        ]}
      />,
    )
    const list = screen.getByRole('list', { name: 'Top namespaces' })
    expect(within(list).getByRole('link', { name: /payments\s*12/ })).toHaveAttribute(
      'href',
      '/ns/payments',
    )
    expect(within(list).getByText('0')).toBeInTheDocument()
  })

  it('handles an empty list', () => {
    renderInRouter(<BarList label="Empty" items={[]} />)
    expect(screen.getByRole('list', { name: 'Empty' })).toBeEmptyDOMElement()
  })
})

describe('TimeSeries', () => {
  const days = ['2026-09-21', '2026-09-22', '2026-09-23']
  const series: TimeSeriesSeries[] = [
    {
      id: 'ok',
      label: 'Succeeded',
      kind: 'bar',
      tone: 'ok',
      points: days.map((x, index) => ({ x, y: [4, 0, 6][index] })),
    },
    {
      id: 'err',
      label: 'Failed',
      kind: 'bar',
      tone: 'err',
      points: days.map((x, index) => ({ x, y: [1, 0, null][index] })),
    },
    {
      id: 'p50',
      label: 'Median',
      kind: 'line',
      tone: 'chart-1',
      points: days.map((x, index) => ({ x, y: [null, 2, 3][index] })),
    },
  ]

  it('carries every value in a hidden table', () => {
    const { container } = render(<TimeSeries series={series} height={160} label="Runs per day" />)
    const table = screen.getByRole('table', { name: 'Runs per day' })
    const rows = within(table).getAllByRole('row')
    expect(rows[0]).toHaveTextContent('DateSucceededFailedMedian')
    expect(rows[1]).toHaveTextContent('Sep 2141—')
    expect(rows[3]).toHaveTextContent('Sep 236—3')
    expect(geometry(container)).not.toMatch(/NaN|Infinity/)
  })

  it('moves a crosshair and tooltip with the arrow keys', async () => {
    const user = userEvent.setup()
    const { container } = render(<TimeSeries series={series} height={160} label="Runs per day" />)
    const points = screen.getAllByRole('img')
    expect(points).toHaveLength(3)
    expect(points[0]).toHaveAccessibleName('Sep 21: Succeeded 4, Failed 1, Median no data')

    await user.tab()
    expect(points[0]).toHaveFocus()
    expect(container.querySelector('.chart-crosshair')).toBeInTheDocument()
    await user.keyboard('{ArrowRight}')
    expect(points[1]).toHaveFocus()
    expect(container.querySelector('.chart-tooltip')).toHaveTextContent('Sep 22')
    await user.keyboard('{End}')
    expect(points[2]).toHaveFocus()
    // Only one point is a tab stop, so the chart costs one Tab, not fourteen.
    expect(points.filter((point) => point.getAttribute('tabindex') === '0')).toHaveLength(1)
  })

  it('dashes a line series and its legend key when asked', () => {
    const tail = {
      id: 'p95',
      label: 'Slowest 5%',
      kind: 'line' as const,
      tone: 'chart-2' as const,
      dashed: true,
      points: days.map((x) => ({ x, y: 5 })),
    }
    const { container } = render(
      <TimeSeries series={[...series, tail]} height={160} label="Runs per day" />,
    )
    const lines = container.querySelectorAll('.time-series-line')
    expect(lines).toHaveLength(2)
    expect(lines[0]).not.toHaveClass('is-dashed')
    expect(lines[1]).toHaveClass('is-dashed')
    const keys = container.querySelectorAll<HTMLElement>('.chart-legend .chart-key--line')
    expect(keys[1].style.background).toContain('repeating-linear-gradient')
  })

  it('says so when no series has a value', () => {
    const { container } = render(
      <TimeSeries
        series={[
          {
            id: 'a',
            label: 'A',
            kind: 'line',
            tone: 'chart-1',
            points: [{ x: '2026-09-21', y: null }],
          },
        ]}
        height={120}
        label="Durations"
        emptyLabel="Nothing to time"
      />,
    )
    expect(screen.getByRole('figure', { name: 'Durations' })).toHaveTextContent('Nothing to time')
    expect(container.querySelector('svg')).toBeNull()
  })

  it('draws in on first mount only, never on a data refresh', () => {
    vi.useFakeTimers()
    const { container, rerender } = render(
      <TimeSeries series={series} height={160} label="Runs per day" />,
    )
    expect(container.querySelector('.time-series-bars')).toHaveClass('is-entering')
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    rerender(
      <TimeSeries
        series={series.map((entry) => ({
          ...entry,
          points: [...entry.points, { x: '2026-09-24', y: 2 }],
        }))}
        height={160}
        label="Runs per day"
      />,
    )
    expect(container.querySelector('.time-series-bars')).not.toHaveClass('is-entering')
    expect(container.querySelector('.chart-reveal')).toBeNull()
  })
})
