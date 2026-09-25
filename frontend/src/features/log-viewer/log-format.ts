import type { LogLevel } from './log-parse'
import type { LogLine } from './useLogStream'

export type SearchOptions = { caseSensitive: boolean; regex: boolean }

export type Matcher = { pattern: RegExp | null; invalid: boolean }

/** Lines rendered in full below this; virtualised at or above it. */
export const virtualizeThreshold = 300

/** Enough to navigate; counting past this would stall typing on a 50k buffer. */
export const maxMatches = 10_000

export function buildMatcher(query: string, { caseSensitive, regex }: SearchOptions): Matcher {
  if (!query) return { pattern: null, invalid: false }
  const source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  try {
    return { pattern: new RegExp(source, caseSensitive ? 'g' : 'gi'), invalid: false }
  } catch {
    return { pattern: null, invalid: true }
  }
}

export type MatchRange = { start: number; end: number }
export type Match = MatchRange & { row: number }

/** Every match in display order, as the row it is on and its offsets. */
export function findMatches(lines: LogLine[], pattern: RegExp | null): Match[] {
  const matches: Match[] = []
  if (!pattern) return matches
  for (let row = 0; row < lines.length && matches.length < maxMatches; row += 1) {
    pattern.lastIndex = 0
    const message = lines[row].message
    let found: RegExpExecArray | null
    while ((found = pattern.exec(message)) && matches.length < maxMatches) {
      // A pattern such as `a*` matches the empty string; step past it rather
      // than loop forever, and do not highlight nothing.
      if (found[0].length === 0) {
        pattern.lastIndex += 1
        continue
      }
      matches.push({ row, start: found.index, end: found.index + found[0].length })
    }
  }
  return matches
}

/** Maps pods onto the six chart hues, stably, so a pod keeps its colour. */
export function podHue(podName: string) {
  // FNV-1a: pod names differ only in a short suffix, and a weaker hash sends
  // sibling pods to the same hue.
  let hash = 0x811c9dc5
  for (let index = 0; index < podName.length; index += 1) {
    hash = Math.imul(hash ^ podName.charCodeAt(index), 0x01000193)
  }
  return ((hash >>> 0) % 6) + 1
}

/** Wall-clock time to the millisecond; the full timestamp is in the title. */
export function formatLogTime(timestamp?: string) {
  if (!timestamp) return ''
  const date = new Date(timestamp.replace(/(\.\d{3})\d+/, '$1'))
  if (Number.isNaN(date.getTime())) return timestamp
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  return (
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}`
  )
}

export function formatLogText(
  lines: LogLine[],
  { timestamps = true, pods = true }: { timestamps?: boolean; pods?: boolean } = {},
) {
  return lines
    .map((line) =>
      [timestamps && line.timestamp, pods && line.podName && `[${line.podName}]`, line.message]
        .filter(Boolean)
        .join(' '),
    )
    .join('\n')
}

export function levelCounts(lines: LogLine[]) {
  const counts: Record<LogLevel, number> = { error: 0, warn: 0, info: 0, debug: 0 }
  for (const line of lines) if (line.level) counts[line.level] += 1
  return counts
}

/** `payments-api-abc-2026-09-24T101500.log` — sortable and filesystem-safe. */
export function logFileName(name: string, container?: string, now = new Date()) {
  const stamp = now
    .toISOString()
    .replace(/[:]/g, '')
    .replace(/\.\d+Z$/, '')
  const base = [name, container].filter(Boolean).join('-')
  return `${base.replace(/[^a-zA-Z0-9._-]/g, '_')}-${stamp}.log`
}

/** Saves text as a file without a round trip to the server. */
export function downloadText(text: string, fileName: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.append(link)
  link.click()
  link.remove()
  // Revoked on the next task: some browsers start the download asynchronously.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
