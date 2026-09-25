import { describe, expect, it } from 'vitest'
import { bandScale, linearScale, niceTicks, tickIndexes, timeScale } from './scale'

describe('niceTicks', () => {
  it.each([
    { min: 0, max: 7, count: 4, ticks: [0, 2, 4, 6, 8] },
    { min: 0, max: 100, count: 4, ticks: [0, 50, 100] },
    { min: 0, max: 0.3, count: 3, ticks: [0, 0.1, 0.2, 0.3] },
    { min: 0, max: 0, count: 4, ticks: [0, 0.5, 1] },
    { min: 5, max: 5, count: 4, ticks: [0, 2, 4, 6] },
    { min: 10, max: 0, count: 2, ticks: [0, 5, 10] },
  ])('rounds [$min, $max] to $ticks', ({ min, max, count, ticks }) => {
    expect(niceTicks(min, max, count).ticks).toEqual(ticks)
  })

  it.each([
    { min: 0, max: 0, ticks: [0, 1] },
    { min: 0, max: 3, ticks: [0, 1, 2, 3] },
    { min: Number.NaN, max: Number.POSITIVE_INFINITY, ticks: [0, 1] },
  ])('keeps an integer axis on whole steps for [$min, $max]', ({ min, max, ticks }) => {
    expect(niceTicks(min, max, 4, { integer: true }).ticks).toEqual(ticks)
  })
})

describe('linearScale', () => {
  it('maps the domain onto the range, inverted for SVG y', () => {
    const y = linearScale([0, 10], [100, 0])
    expect(y(0)).toBe(100)
    expect(y(5)).toBe(50)
    expect(y(10)).toBe(0)
  })

  it('never returns a non-finite coordinate', () => {
    expect(linearScale([3, 3], [0, 10])(3)).toBe(5)
    expect(linearScale([0, 10], [0, 10])(Number.NaN)).toBe(0)
    expect(Number.isFinite(linearScale([Number.NaN, 1], [0, 10])(1))).toBe(true)
  })
})

describe('bandScale', () => {
  it('lays keys out in order with padding between bands', () => {
    const x = bandScale(['a', 'b', 'c'], [0, 300], { paddingInner: 0, paddingOuter: 0 })
    expect(x('a')).toBe(0)
    expect(x('b')).toBe(100)
    expect(x.bandwidth).toBe(100)
    expect(x.index('c')).toBe(2)
  })

  it('handles an empty domain', () => {
    const x = bandScale([], [0, 300])
    expect(x.bandwidth).toBe(0)
    expect(x('missing')).toBe(0)
  })
})

describe('timeScale', () => {
  it('maps instants linearly', () => {
    const start = new Date('2026-09-01T00:00:00Z')
    const end = new Date('2026-09-11T00:00:00Z')
    const x = timeScale([start, end], [0, 100])
    expect(x(new Date('2026-09-06T00:00:00Z'))).toBe(50)
  })
})

describe('tickIndexes', () => {
  it('keeps every label when they fit and the last one when they do not', () => {
    expect(tickIndexes(3, 7)).toEqual([0, 1, 2])
    expect(tickIndexes(14, 7)).toEqual([1, 3, 5, 7, 9, 11, 13])
    expect(tickIndexes(0, 7)).toEqual([])
  })
})
