import { describe, expect, it } from 'vitest'
import { parseLogLine, stripAnsi, type LogLevel } from './log-parse'

describe('parseLogLine', () => {
  const cases: [string, string, LogLevel | null][] = [
    ['JSON level', '{"level":"error","msg":"db down"}', 'error'],
    ['JSON severity', '{"severity":"WARNING","message":"slow"}', 'warn'],
    ['JSON numeric pino level', '{"level":30,"msg":"listening"}', 'info'],
    ['JSON nested ECS level', '{"log":{"level":"debug"},"message":"x"}', 'debug'],
    ['JSON without a level', '{"msg":"hello"}', null],
    ['klog error', 'E0102 15:04:05.000000       1 controller.go:42] sync failed', 'error'],
    ['klog warning', 'W0102 15:04:05.000000       1 reflector.go:1] watch closed', 'warn'],
    ['klog info', 'I0924 09:00:00.123456       1 main.go:7] starting', 'info'],
    ['bracketed token', '[ERROR] connection refused', 'error'],
    ['colon token', 'WARN: cache miss rate high', 'warn'],
    ['token after a timestamp', '2026-09-24 10:00:00 INFO  Started in 2.1s', 'info'],
    ['logfmt', 'ts=2026-09-24 level=debug msg="tick"', 'debug'],
    ['fatal maps to error', 'FATAL could not bind :8080', 'error'],
    ['trace maps to debug', 'TRACE entering handler', 'debug'],
    ['prose mention is not a level', 'GET /health 200 in 3ms; retrying later', null],
    ['plain line', 'server started on :8080', null],
  ]

  it.each(cases)('%s', (_name, line, level) => {
    expect(parseLogLine(line).level).toBe(level)
  })

  it('keeps the parsed JSON for structured lines', () => {
    expect(parseLogLine('{"level":"info","user":"ada"}').json).toEqual({
      level: 'info',
      user: 'ada',
    })
    expect(parseLogLine('{not json}').json).toBeUndefined()
  })

  it('strips ANSI colours before detecting the level', () => {
    const coloured = '\u001b[31mERROR\u001b[0m disk full\r'
    expect(parseLogLine(coloured)).toEqual({ level: 'error', message: 'ERROR disk full' })
  })
})

describe('stripAnsi', () => {
  it('removes CSI and OSC sequences and leaves plain text alone', () => {
    expect(stripAnsi('\u001b[1;32mok\u001b[0m')).toBe('ok')
    expect(stripAnsi('\u001b]0;title\u0007done')).toBe('done')
    expect(stripAnsi('plain')).toBe('plain')
  })
})
