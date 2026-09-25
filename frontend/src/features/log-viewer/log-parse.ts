export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

export type ParsedLogLine = {
  level: LogLevel | null
  /** The line with terminal colour codes removed. */
  message: string
  /** Present when the line is a JSON object, e.g. structured logging. */
  json?: Record<string, unknown>
}

export const logLevels: LogLevel[] = ['error', 'warn', 'info', 'debug']

// CSI sequences (colours, cursor moves) and OSC sequences (titles, links).
// eslint-disable-next-line no-control-regex
const ansiPattern = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g

export function stripAnsi(text: string) {
  return text.includes('\u001b') ? text.replace(ansiPattern, '') : text
}

const levelAliases: Record<string, LogLevel> = {
  fatal: 'error',
  panic: 'error',
  crit: 'error',
  critical: 'error',
  alert: 'error',
  emerg: 'error',
  emergency: 'error',
  err: 'error',
  error: 'error',
  severe: 'error',
  warn: 'warn',
  warning: 'warn',
  notice: 'info',
  info: 'info',
  information: 'info',
  debug: 'debug',
  trace: 'debug',
  verbose: 'debug',
  fine: 'debug',
}

// pino and bunyan log numeric levels: 10 trace … 60 fatal.
function numericLevel(value: number): LogLevel | null {
  if (value >= 50) return 'error'
  if (value >= 40) return 'warn'
  if (value >= 30) return 'info'
  if (value >= 10) return 'debug'
  return null
}

function normaliseLevel(value: unknown): LogLevel | null {
  if (typeof value === 'number') return numericLevel(value)
  if (typeof value !== 'string') return null
  return levelAliases[value.trim().toLowerCase()] ?? null
}

const jsonLevelKeys = ['level', 'severity', 'lvl', 'loglevel', 'log.level', 'levelname']

function jsonLevel(json: Record<string, unknown>) {
  for (const key of jsonLevelKeys) {
    const level = normaliseLevel(json[key])
    if (level) return level
  }
  const log = json.log
  if (log && typeof log === 'object') return normaliseLevel((log as { level?: unknown }).level)
  return null
}

// klog: `E0102 15:04:05.000000 …` — severity letter, month, day, then time.
const klogPattern = /^([EWID])\d{4}\s+\d{2}:\d{2}:\d{2}/
const klogLevels: Record<string, LogLevel> = { E: 'error', W: 'warn', I: 'info', D: 'debug' }

// logfmt `level=warn`, or a bare token such as `[ERROR]`, `WARN:` or ` info `.
const logfmtPattern = /\b(?:level|lvl|severity)=["']?([a-z]+)/i
const tokenPattern =
  /(?:^|[\s[(|:])(FATAL|PANIC|CRITICAL|CRIT|ERROR|ERR|WARNING|WARN|INFO|NOTICE|DEBUG|TRACE)(?=[\s\]):|]|$)/i

function textLevel(message: string): LogLevel | null {
  const klog = klogPattern.exec(message)
  if (klog) return klogLevels[klog[1]]
  const logfmt = logfmtPattern.exec(message)
  if (logfmt) {
    const level = normaliseLevel(logfmt[1])
    if (level) return level
  }
  // Only the head of the line: a level token deep inside a message ("retrying
  // after error") is prose, not the line's severity.
  const token = tokenPattern.exec(message.slice(0, 80))
  return token ? normaliseLevel(token[1]) : null
}

/** Pulls the severity out of a log line, whatever shape the app logs in. */
export function parseLogLine(raw: string): ParsedLogLine {
  const message = stripAnsi(raw).replace(/\r$/, '')
  const trimmed = message.trimStart()
  if (trimmed.startsWith('{') && trimmed.trimEnd().endsWith('}')) {
    try {
      const json = JSON.parse(trimmed) as unknown
      if (json && typeof json === 'object' && !Array.isArray(json)) {
        const record = json as Record<string, unknown>
        return { level: jsonLevel(record), message, json: record }
      }
    } catch {
      // Not JSON after all; fall through to text detection.
    }
  }
  return { level: textLevel(message), message }
}
