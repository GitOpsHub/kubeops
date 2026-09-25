export const defaultLogCapacity = 10_000
export const maxLogCapacity = 50_000

/**
 * A fixed-capacity ring: pushing past capacity overwrites the oldest item, so
 * an hour of chatty logs costs the same memory as a minute and a push never
 * copies the array. `version` bumps on every change, which is what a React
 * consumer keys memoised views on; `total` counts every item ever pushed, so
 * line numbers stay stable after the oldest lines fall off.
 */
export class RingBuffer<T> {
  readonly capacity: number
  private items: (T | undefined)[]
  private start = 0
  private count = 0
  private pushed = 0
  private revision = 0

  constructor(capacity = defaultLogCapacity) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError('capacity must be a positive integer')
    }
    this.capacity = Math.min(capacity, maxLogCapacity)
    this.items = new Array(this.capacity)
  }

  get size() {
    return this.count
  }

  get version() {
    return this.revision
  }

  /** Every item ever pushed, including those since overwritten. */
  get total() {
    return this.pushed
  }

  /** How many of the oldest items have been overwritten. */
  get dropped() {
    return this.pushed - this.count
  }

  push(item: T) {
    const index = (this.start + this.count) % this.capacity
    this.items[index] = item
    if (this.count < this.capacity) this.count += 1
    else this.start = (this.start + 1) % this.capacity
    this.pushed += 1
    this.revision += 1
  }

  pushAll(items: Iterable<T>) {
    for (const item of items) this.push(item)
  }

  /** The item `index` places from the oldest retained one. */
  at(index: number): T | undefined {
    if (index < 0 || index >= this.count) return undefined
    return this.items[(this.start + index) % this.capacity]
  }

  last(): T | undefined {
    return this.at(this.count - 1)
  }

  /** Oldest to newest, like `Array.prototype.slice`. */
  slice(begin = 0, end = this.count): T[] {
    const from = Math.max(0, begin < 0 ? this.count + begin : begin)
    const to = Math.min(this.count, end < 0 ? this.count + end : end)
    const result: T[] = []
    for (let index = from; index < to; index += 1) result.push(this.at(index) as T)
    return result
  }

  toArray(): T[] {
    return this.slice()
  }

  clear() {
    this.items = new Array(this.capacity)
    this.start = 0
    this.count = 0
    this.pushed = 0
    this.revision += 1
  }
}
