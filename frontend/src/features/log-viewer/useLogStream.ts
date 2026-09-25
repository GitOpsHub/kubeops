import { useCallback, useEffect, useRef, useState } from 'react'
import {
  LogStreamInterruptedError,
  streamTargetLogs,
  type LogResourceRef,
  type PodLogEntry,
} from '../../api/argo'
import { ApiError, errorMessage, isAbortError } from '../../api/client'
import { defaultLogCapacity, RingBuffer } from './log-buffer'
import { parseLogLine, type LogLevel } from './log-parse'

export type LogLine = {
  /** 1-based and stable: lines keep their number after older ones fall off. */
  seq: number
  /** What de-duplication compares: pod, timestamp, and content. */
  key: string
  timestamp?: string
  podName?: string
  content: string
  level: LogLevel | null
  message: string
  json?: Record<string, unknown>
}

/** `idle` means no resource is picked, so nothing streams. */
export type LogStreamStatus =
  'idle' | 'connecting' | 'live' | 'paused' | 'reconnecting' | 'ended' | 'error'

export type LogStreamError = { message: string; status?: number }

export type LogStreamParams = {
  onboardingId: string
  targetId: string
  /** Nothing streams while this is null, e.g. before a resource is picked. */
  resource: LogResourceRef | null
  container?: string
  tailLines?: number
  sinceSeconds?: number
  previous?: boolean
  filter?: string
  /** Keeps the connection but holds new lines back until resumed. */
  paused?: boolean
  capacity?: number
  /** Waits before each resume attempt; the last repeats. */
  reconnectDelaysMs?: number[]
  /** Consecutive fruitless resumes before the stream is declared ended. */
  maxReconnectAttempts?: number
}

export const defaultReconnectDelaysMs = [1_000, 2_000, 5_000]
const defaultMaxReconnectAttempts = 6
/** A stream that stayed open this long was healthy, even if the pod was quiet. */
const healthyStreamMs = 15_000
/** The most a resumed stream is asked to replay; also the overlap window. */
const resumeTailLines = 5_000

type Snapshot = { lines: LogLine[]; version: number }
const emptySnapshot: Snapshot = { lines: [], version: 0 }

type FrameHandle = { cancel: () => void }

// jsdom and some embedded webviews lack rAF; a 16ms timer is the same cadence.
function nextFrame(callback: () => void): FrameHandle {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(() => callback())
    return { cancel: () => cancelAnimationFrame(id) }
  }
  const id = setTimeout(callback, 16)
  return { cancel: () => clearTimeout(id) }
}

// Kubernetes stamps nanoseconds; Date.parse is only reliable to milliseconds.
function timeValue(timestamp?: string) {
  if (!timestamp) return Number.NaN
  return Date.parse(timestamp.replace(/(\.\d{3})\d+/, '$1'))
}

export function logLineKey(entry: PodLogEntry) {
  return `${entry.podName ?? ''}|${entry.timestamp ?? ''}|${entry.content ?? ''}`
}

/**
 * Streams a resource's logs into a bounded ring buffer and hands React one
 * snapshot per animation frame, however fast lines arrive — a chatty pod can
 * emit thousands of lines a second, and one render per line would lock the
 * tab.
 *
 * A following stream that the server closes (a serverless function reaching
 * its maximum duration, a proxy idling out) is resumed after a short backoff
 * from the newest timestamp seen. Kubernetes truncates `sinceTime` to the
 * second, so the resumed stream replays part of what is already on screen;
 * those lines are dropped by pod, timestamp, and content.
 */
export function useLogStream({
  onboardingId,
  targetId,
  resource,
  container,
  tailLines,
  sinceSeconds,
  previous = false,
  filter,
  paused = false,
  capacity = defaultLogCapacity,
  reconnectDelaysMs = defaultReconnectDelaysMs,
  maxReconnectAttempts = defaultMaxReconnectAttempts,
}: LogStreamParams) {
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot)
  const [status, setStatus] = useState<LogStreamStatus>(resource ? 'connecting' : 'idle')
  const [error, setError] = useState<LogStreamError | null>(null)
  const [held, setHeld] = useState(0)
  const [reconnectAttempt, setReconnectAttempt] = useState(0)
  const [restartToken, setRestartToken] = useState(0)

  const bufferRef = useRef<RingBuffer<LogLine> | null>(null)
  const pendingRef = useRef<LogLine[]>([])
  const seqRef = useRef(0)
  const frameRef = useRef<FrameHandle | null>(null)
  const pausedRef = useRef(paused)

  // Delays are usually an inline array literal; comparing by value keeps a
  // re-render from tearing the stream down.
  const delaysKey = reconnectDelaysMs.join(',')

  const flush = useCallback(() => {
    frameRef.current = null
    const pending = pendingRef.current
    if (pausedRef.current) {
      setHeld(pending.length)
      return
    }
    const buffer = bufferRef.current
    if (!buffer || pending.length === 0) return
    buffer.pushAll(pending)
    pendingRef.current = []
    setSnapshot({ lines: buffer.toArray(), version: buffer.version })
    setHeld(0)
  }, [])

  const scheduleFlush = useCallback(() => {
    if (!frameRef.current) frameRef.current = nextFrame(flush)
  }, [flush])

  useEffect(() => {
    pausedRef.current = paused
    scheduleFlush()
  }, [paused, scheduleFlush])

  const kind = resource?.kind ?? ''
  const name = resource?.name ?? ''
  const namespace = resource?.namespace ?? ''

  useEffect(() => {
    const buffer = new RingBuffer<LogLine>(capacity)
    bufferRef.current = buffer
    pendingRef.current = []
    seqRef.current = 0
    setSnapshot(emptySnapshot)
    setHeld(0)
    setError(null)
    setReconnectAttempt(0)
    if (!kind || !name) {
      setStatus('idle')
      return
    }

    const controller = new AbortController()
    const delays = delaysKey.split(',').map(Number)
    const follow = !previous
    let newest: string | undefined
    let newestValue = Number.NEGATIVE_INFINITY
    let overlap: Set<string> | null = null
    let overlapCutoff = Number.NEGATIVE_INFINITY
    // Keys of the newest timestamped lines received, kept apart from the
    // buffer so a resume after clear() still skips what was already shown.
    let recentKeys: string[] = []
    let attempt = 0
    let timer: ReturnType<typeof setTimeout> | undefined

    const accept = (entry: PodLogEntry) => {
      const key = logLineKey(entry)
      const value = timeValue(entry.timestamp)
      // Only a timestamped line can be told apart from a later identical
      // one; untimed lines (heartbeats, "ok") may repeat after a resume
      // rather than be dropped.
      if (entry.timestamp) {
        if (overlap && overlap.has(key) && !(value > overlapCutoff)) return false
        recentKeys.push(key)
        if (recentKeys.length > resumeTailLines * 2) recentKeys = recentKeys.slice(-resumeTailLines)
      }
      if (value > newestValue) {
        newestValue = value
        newest = entry.timestamp
      }
      const content = entry.content ?? ''
      seqRef.current += 1
      pendingRef.current.push({
        seq: seqRef.current,
        key,
        timestamp: entry.timestamp,
        podName: entry.podName,
        content,
        ...parseLogLine(content),
      })
      // Held lines are bounded too, so a long pause cannot outgrow the buffer.
      if (pendingRef.current.length > capacity * 2) {
        pendingRef.current = pendingRef.current.slice(-capacity)
      }
      scheduleFlush()
      return true
    }

    // Everything already received that a resumed stream may replay.
    const overlapKeys = () => new Set(recentKeys.slice(-resumeTailLines))

    const resumeOrEnd = (startedAt: number, fresh: number) => {
      if (!follow) {
        setStatus('ended')
        return
      }
      if (fresh > 0 || Date.now() - startedAt >= healthyStreamMs) attempt = 0
      if (attempt >= maxReconnectAttempts) {
        setStatus('ended')
        return
      }
      const delay = delays[Math.min(attempt, delays.length - 1)] ?? 0
      attempt += 1
      overlap = overlapKeys()
      overlapCutoff = newestValue
      setReconnectAttempt(attempt)
      setStatus('reconnecting')
      timer = setTimeout(() => void connect(true), delay)
    }

    const connect = async (resume: boolean) => {
      const startedAt = Date.now()
      let fresh = 0
      const since = resume && newest ? { sinceTime: newest } : { sinceSeconds }
      try {
        await streamTargetLogs({
          onboardingId,
          targetId,
          ref: { kind, name, namespace },
          container,
          tailLines: resume && newest ? resumeTailLines : tailLines,
          ...since,
          previous,
          follow,
          filter,
          signal: controller.signal,
          onOpen: () => setStatus('live'),
          onEntry: (entry) => {
            if (accept(entry)) fresh += 1
          },
        })
        if (controller.signal.aborted) return
        resumeOrEnd(startedAt, fresh)
      } catch (streamError) {
        if (controller.signal.aborted || isAbortError(streamError)) return
        // A dropped connection or a stream the server says broke off is
        // worth resuming; a refusal from the API or an error line from Argo CD
        // is not going to change on retry.
        const interrupted =
          streamError instanceof TypeError || streamError instanceof LogStreamInterruptedError
        if (interrupted && follow) {
          resumeOrEnd(startedAt, fresh)
          return
        }
        setError({
          message: errorMessage(streamError, 'Logs are unavailable'),
          status: streamError instanceof ApiError ? streamError.status : undefined,
        })
        setStatus('error')
      }
    }

    setStatus('connecting')
    void connect(false)
    return () => {
      controller.abort()
      if (timer) clearTimeout(timer)
      frameRef.current?.cancel()
      frameRef.current = null
    }
  }, [
    onboardingId,
    targetId,
    kind,
    name,
    namespace,
    container,
    tailLines,
    sinceSeconds,
    previous,
    filter,
    capacity,
    delaysKey,
    maxReconnectAttempts,
    restartToken,
    scheduleFlush,
  ])

  const clear = useCallback(() => {
    bufferRef.current?.clear()
    pendingRef.current = []
    seqRef.current = 0
    setSnapshot(emptySnapshot)
    setHeld(0)
  }, [])

  const restart = useCallback(() => setRestartToken((token) => token + 1), [])

  return {
    lines: snapshot.lines,
    version: snapshot.version,
    status: status === 'live' && paused ? ('paused' as const) : status,
    error,
    /** Lines received while paused and not yet shown. */
    held,
    reconnectAttempt,
    clear,
    restart,
  }
}
