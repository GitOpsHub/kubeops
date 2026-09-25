import { describe, expect, it } from 'vitest'
import { defaultLogCapacity, maxLogCapacity, RingBuffer } from './log-buffer'

describe('RingBuffer', () => {
  it('keeps items in order until it reaches capacity', () => {
    const buffer = new RingBuffer<number>(3)
    buffer.pushAll([1, 2])
    expect(buffer.toArray()).toEqual([1, 2])
    expect(buffer.size).toBe(2)
    expect(buffer.dropped).toBe(0)
  })

  it('overwrites the oldest items once full', () => {
    const buffer = new RingBuffer<number>(3)
    buffer.pushAll([1, 2, 3, 4, 5])
    expect(buffer.toArray()).toEqual([3, 4, 5])
    expect(buffer.size).toBe(3)
    expect(buffer.total).toBe(5)
    expect(buffer.dropped).toBe(2)
    expect(buffer.at(0)).toBe(3)
    expect(buffer.last()).toBe(5)
    expect(buffer.at(3)).toBeUndefined()
  })

  it('slices across the wraparound point like an array', () => {
    const buffer = new RingBuffer<number>(4)
    buffer.pushAll([1, 2, 3, 4, 5, 6])
    const items = [3, 4, 5, 6]
    const cases: [number | undefined, number | undefined][] = [
      [undefined, undefined],
      [1, 3],
      [-2, undefined],
      [0, -1],
      [3, 10],
      [5, 6],
    ]
    for (const [begin, end] of cases) {
      expect(buffer.slice(begin, end)).toEqual(items.slice(begin, end))
    }
  })

  it('bumps the version on every change', () => {
    const buffer = new RingBuffer<string>(2)
    const start = buffer.version
    buffer.push('a')
    buffer.push('b')
    buffer.push('c')
    expect(buffer.version).toBe(start + 3)
    buffer.clear()
    expect(buffer.version).toBe(start + 4)
    expect(buffer.toArray()).toEqual([])
    expect(buffer.total).toBe(0)
    buffer.push('d')
    expect(buffer.toArray()).toEqual(['d'])
  })

  it('defaults to 10k items and caps capacity at 50k', () => {
    expect(new RingBuffer().capacity).toBe(defaultLogCapacity)
    expect(new RingBuffer(50_000).capacity).toBe(50_000)
    expect(new RingBuffer(80_000).capacity).toBe(maxLogCapacity)
    expect(() => new RingBuffer(0)).toThrow(RangeError)
  })

  it('stays bounded under a long stream', () => {
    const buffer = new RingBuffer<number>(1_000)
    for (let index = 0; index < 25_000; index += 1) buffer.push(index)
    expect(buffer.size).toBe(1_000)
    expect(buffer.at(0)).toBe(24_000)
    expect(buffer.last()).toBe(24_999)
  })
})
