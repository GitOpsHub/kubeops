import { useVirtualizer } from '@tanstack/react-virtual'
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import {
  getResourceContainers,
  isMultiPodKind,
  type LogResourceRef,
  type ResourceContainer,
} from '../../api/argo'
import { isAbortError } from '../../api/client'
import {
  CaseSensitiveIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ClearIcon,
  CopyIcon,
  DownloadIcon,
  ExitFullscreenIcon,
  FullscreenIcon,
  JumpToLatestIcon,
  PauseIcon,
  PlayIcon,
  RegexIcon,
  SearchIcon,
  SpinnerIcon,
  WrapIcon,
} from '../../components/icons'
import { Button } from '../../components/ui/Button'
import { Kbd } from '../../components/ui/Kbd'
import { StatusDot } from '../../components/ui/StatusDot'
import { useToast } from '../../components/ui/toast-context'
import type { Tone } from '../../lib/status'
import {
  buildMatcher,
  downloadText,
  findMatches,
  formatLogText,
  formatLogTime,
  levelCounts,
  logFileName,
  maxPodLabelLength,
  podHue,
  podNamePrefix,
  shortPodName,
  virtualizeThreshold,
  type MatchRange,
} from './log-format'
import { logLevels, type LogLevel } from './log-parse'
import { useLogStream, type LogLine, type LogStreamStatus } from './useLogStream'
import './log-viewer.css'

type SinceOption = 'tail' | '1m' | '5m' | '15m' | '1h' | '6h'

const sinceOptions: { value: SinceOption; label: string; seconds?: number }[] = [
  { value: 'tail', label: 'Tail only' },
  { value: '1m', label: 'Last minute', seconds: 60 },
  { value: '5m', label: 'Last 5 minutes', seconds: 300 },
  { value: '15m', label: 'Last 15 minutes', seconds: 900 },
  { value: '1h', label: 'Last hour', seconds: 3_600 },
  { value: '6h', label: 'Last 6 hours', seconds: 21_600 },
]

const tailOptions = [100, 500, 1_000, 5_000]

const statusTones: Record<LogStreamStatus, Tone> = {
  connecting: 'info',
  live: 'ok',
  paused: 'warn',
  reconnecting: 'warn',
  ended: 'idle',
  error: 'err',
}

const statusLabels: Record<LogStreamStatus, string> = {
  connecting: 'Connecting',
  live: 'Live',
  paused: 'Paused',
  reconnecting: 'Reconnecting',
  ended: 'Ended',
  error: 'Error',
}

const levelLabels: Record<LogLevel, string> = {
  error: 'Error',
  warn: 'Warn',
  info: 'Info',
  debug: 'Debug',
}

/** Past this distance from the bottom, the reader has scrolled away from the tail. */
const bottomSlackPx = 24

export type LogViewerProps = {
  onboardingId: string
  targetId: string
  resource: LogResourceRef
  /** Pickers placed at the start of the toolbar, e.g. target and resource. */
  pickers?: ReactNode
  /** Preselects a container, e.g. from a deep link. */
  initialContainer?: string
  /** Lines kept in memory; 10,000 by default, at most 50,000. */
  capacity?: number
  className?: string
}

type ToolToggleProps = {
  pressed: boolean
  onChange: (pressed: boolean) => void
  label: string
  icon?: ReactNode
  children?: ReactNode
  title?: string
}

function ToolToggle({ pressed, onChange, label, icon, children, title }: ToolToggleProps) {
  return (
    <button
      type="button"
      className={`log-tool${pressed ? ' is-active' : ''}${children ? '' : ' log-tool--icon'}`}
      aria-pressed={pressed}
      // The visible text is always a prefix of the name, so voice control
      // users can say what they see.
      aria-label={label}
      title={title ?? label}
      onClick={() => onChange(!pressed)}
    >
      {icon}
      {children}
    </button>
  )
}

function highlight(message: string, ranges: MatchRange[] | undefined, activeStart: number) {
  if (!ranges?.length) return message
  const parts: ReactNode[] = []
  let cursor = 0
  ranges.forEach((range, index) => {
    if (range.start > cursor) parts.push(message.slice(cursor, range.start))
    parts.push(
      <mark key={index} className={range.start === activeStart ? 'log-mark is-active' : 'log-mark'}>
        {message.slice(range.start, range.end)}
      </mark>,
    )
    cursor = range.end
  })
  if (cursor < message.length) parts.push(message.slice(cursor))
  return parts
}

type RowProps = {
  line: LogLine
  index: number
  showTimestamps: boolean
  showPods: boolean
  /** Stripped from pod names: every pod on screen starts with it. */
  podPrefix: string
  ranges?: MatchRange[]
  /** Start offset of the active match when it is on this row, else -1. */
  activeStart: number
}

function LogRow({
  line,
  index,
  showTimestamps,
  showPods,
  podPrefix,
  ranges,
  activeStart,
}: RowProps) {
  const pod = line.podName ?? ''
  const shortPod = shortPodName(pod, podPrefix)
  return (
    <>
      <span className="log-ln" aria-hidden="true">
        {line.seq}
      </span>
      {showTimestamps && (
        <time className="log-ts" dateTime={line.timestamp} title={line.timestamp}>
          {formatLogTime(line.timestamp)}
        </time>
      )}
      {showPods && (
        <span
          className="log-pod"
          style={{ '--pod-hue': `var(--chart-${podHue(pod)})` } as object}
          title={pod}
        >
          {shortPod || '—'}
        </span>
      )}
      <span className="log-msg" data-row={index}>
        {highlight(line.message, ranges, activeStart)}
      </span>
    </>
  )
}

/**
 * The one log viewer: a resource's live logs with the controls an operator
 * reaches for while debugging — container, time window, crashed-container
 * logs, level filter, search, download. It fills whatever box it is given, so
 * the sheet, a detail tab, and the full-page route all host the same thing.
 */
export function LogViewer({
  onboardingId,
  targetId,
  resource,
  pickers,
  initialContainer = '',
  capacity,
  className = '',
}: LogViewerProps) {
  const toast = useToast()
  const multiPod = isMultiPodKind(resource.kind)
  const { kind, name, namespace = '' } = resource

  const [containers, setContainers] = useState<ResourceContainer[] | null>(null)
  const [container, setContainer] = useState(initialContainer)
  const [since, setSince] = useState<SinceOption>('tail')
  const [tailLines, setTailLines] = useState(500)
  const [previous, setPrevious] = useState(false)
  const [paused, setPaused] = useState(false)
  const [follow, setFollow] = useState(true)
  const [wrap, setWrap] = useState(true)
  const [showTimestamps, setShowTimestamps] = useState(true)
  const [showPods, setShowPods] = useState(multiPod)
  const [levels, setLevels] = useState<LogLevel[]>([])
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [regex, setRegex] = useState(false)
  const [serverFilter, setServerFilter] = useState(false)
  const [appliedFilter, setAppliedFilter] = useState('')
  const [activeMatch, setActiveMatch] = useState(0)
  const [seenSeq, setSeenSeq] = useState(0)
  const [fullscreen, setFullscreen] = useState(false)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const lastScrollTop = useRef(0)

  // The stream waits for the container list: a multi-container pod must be
  // asked for one container by name, or Kubernetes refuses the request.
  useEffect(() => {
    setContainers(null)
    const controller = new AbortController()
    getResourceContainers(onboardingId, targetId, { kind, name, namespace }, controller.signal)
      .then((items) => {
        if (controller.signal.aborted) return
        setContainers(items)
        setContainer((current) => {
          if (current && items.some((item) => item.name === current)) return current
          return (items.find((item) => !item.init) ?? items[0])?.name ?? ''
        })
      })
      .catch((error) => {
        // Without the list the server's default container is still worth a try.
        if (!isAbortError(error)) setContainers([])
      })
    return () => controller.abort()
  }, [onboardingId, targetId, kind, name, namespace])

  // Typing should not reconnect per keystroke when filtering on the server.
  useEffect(() => {
    if (!serverFilter) return
    const timer = setTimeout(() => setAppliedFilter(query.trim().slice(0, 256)), 500)
    return () => clearTimeout(timer)
  }, [query, serverFilter])

  const stream = useLogStream({
    onboardingId,
    targetId,
    resource: containers ? resource : null,
    container: container || undefined,
    tailLines,
    sinceSeconds: sinceOptions.find((option) => option.value === since)?.seconds,
    previous,
    filter: serverFilter && appliedFilter ? appliedFilter : undefined,
    paused,
    capacity,
  })
  const { lines } = stream

  const visible = useMemo(
    () =>
      levels.length ? lines.filter((line) => line.level && levels.includes(line.level)) : lines,
    [lines, levels],
  )
  const counts = useMemo(() => levelCounts(lines), [lines])
  const pods = useMemo(
    () => (showPods ? [...new Set(lines.map((line) => line.podName ?? ''))] : []),
    [lines, showPods],
  )
  const podPrefix = podNamePrefix(pods, multiPod ? `${name}-` : '')
  // Sized to the longest label, so two pods of a StatefulSet do not sit in a
  // column built for ReplicaSet hashes; +2ch leaves room for the swatch.
  const podWidth =
    Math.min(
      maxPodLabelLength,
      Math.max(4, ...pods.map((pod) => shortPodName(pod, podPrefix).length)),
    ) + 2
  const matcher = useMemo(
    () => buildMatcher(query, { caseSensitive, regex }),
    [query, caseSensitive, regex],
  )
  const matches = useMemo(() => findMatches(visible, matcher.pattern), [visible, matcher.pattern])
  const rangesByRow = useMemo(() => {
    const byRow = new Map<number, MatchRange[]>()
    for (const match of matches) {
      const ranges = byRow.get(match.row)
      if (ranges) ranges.push(match)
      else byRow.set(match.row, [match])
    }
    return byRow
  }, [matches])
  const currentMatch = matches.length ? Math.min(activeMatch, matches.length - 1) : -1
  const active = currentMatch >= 0 ? matches[currentMatch] : null

  const virtualize = visible.length >= virtualizeThreshold
  // The app does not run React Compiler, so the skipped memoisation this
  // rule warns about changes nothing here.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: virtualize ? visible.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 20,
    overscan: 24,
    getItemKey: (index) => visible[index]?.seq ?? index,
  })

  // Wrapping and columns change every row's height; measured sizes are stale.
  useEffect(() => {
    if (virtualize) virtualizer.measure()
  }, [wrap, showTimestamps, showPods, virtualize, virtualizer])

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!follow || !element) return
    element.scrollTop = element.scrollHeight
    lastScrollTop.current = element.scrollTop
  }, [follow, visible, wrap, showTimestamps, showPods])

  useEffect(() => {
    const onChange = () =>
      setFullscreen(Boolean(rootRef.current) && document.fullscreenElement === rootRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const lastSeq = lines.at(-1)?.seq ?? 0
  const newLines = follow ? 0 : Math.max(0, lastSeq - seenSeq)

  function stopFollowing() {
    if (!follow) return
    setFollow(false)
    setSeenSeq(lastSeq)
  }

  function jumpToLatest() {
    setFollow(true)
  }

  // Only a scroll that moved up counts as the reader leaving the tail: rows
  // growing underneath (measurement, wrapping) must not pause following.
  function onScroll() {
    const element = scrollRef.current
    if (!element) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    if (element.scrollTop < lastScrollTop.current - 1 && distance > bottomSlackPx) stopFollowing()
    else if (!follow && distance <= 2) setFollow(true)
    lastScrollTop.current = element.scrollTop
  }

  function onLogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'End') {
      event.preventDefault()
      jumpToLatest()
    } else if (event.key === 'Home') {
      event.preventDefault()
      stopFollowing()
      if (scrollRef.current) scrollRef.current.scrollTop = 0
    }
  }

  function goToMatch(index: number) {
    if (!matches.length) return
    const next = (index + matches.length) % matches.length
    setActiveMatch(next)
    stopFollowing()
    const row = matches[next].row
    if (virtualize) {
      virtualizer.scrollToIndex(row, { align: 'center' })
    } else {
      scrollRef.current
        ?.querySelector(`[data-index="${row}"]`)
        ?.scrollIntoView?.({ block: 'center' })
    }
  }

  function toggleLevel(level: LogLevel) {
    setLevels((current) =>
      current.includes(level) ? current.filter((item) => item !== level) : [...current, level],
    )
  }

  function clearLines() {
    stream.clear()
    setSeenSeq(0)
  }

  function download() {
    downloadText(formatLogText(lines), logFileName(name, container))
  }

  async function copyVisible() {
    const text = formatLogText(visible, { timestamps: showTimestamps, pods: showPods })
    try {
      await navigator.clipboard.writeText(text)
      toast.success(`Copied ${visible.length.toLocaleString()} lines`)
    } catch {
      toast.error('The logs could not be copied', {
        description: 'The browser did not allow access to the clipboard.',
      })
    }
  }

  function toggleFullscreen() {
    if (fullscreen) void document.exitFullscreen?.()
    else void rootRef.current?.requestFullscreen?.()
  }

  const canFullscreen = typeof document !== 'undefined' && Boolean(document.fullscreenEnabled)
  const choosableContainers = containers ?? []
  const status = stream.status

  const rowClass = (line: LogLine) =>
    `log-row${line.level ? ` log-row--${line.level}` : ''}${
      active && visible[active.row] === line ? ' is-current' : ''
    }`

  function renderRow(line: LogLine, index: number) {
    return (
      <LogRow
        line={line}
        index={index}
        showTimestamps={showTimestamps}
        showPods={showPods}
        podPrefix={podPrefix}
        ranges={rangesByRow.get(index)}
        activeStart={active && active.row === index ? active.start : -1}
      />
    )
  }

  let overlay: ReactNode = null
  if (status === 'error' && stream.error) {
    const forbidden = stream.error.status === 403
    overlay = (
      <div className="log-overlay log-overlay--error" role="alert">
        <strong>{forbidden ? 'Log access isn’t configured' : 'Logs could not be streamed'}</strong>
        <p>
          {forbidden
            ? 'Argo CD refused to read logs on this cluster. Grant the KubeOps account the “logs, get” permission in Argo CD’s RBAC policy, then try again.'
            : stream.error.message}
        </p>
        <Button size="sm" onClick={stream.restart}>
          Try again
        </Button>
      </div>
    )
  } else if (lines.length === 0) {
    if (status === 'connecting') {
      overlay = (
        <div className="log-overlay" role="status">
          <SpinnerIcon className="log-spin" aria-hidden="true" />
          <p>Connecting to {name}…</p>
        </div>
      )
    } else if (status === 'ended') {
      overlay = (
        <div className="log-overlay" role="status">
          <strong>No log lines</strong>
          <p>
            {previous
              ? 'There is no previous container instance, or it logged nothing.'
              : 'Nothing was logged in this window. Widen the time range or tail more lines.'}
          </p>
          <Button size="sm" onClick={stream.restart}>
            Stream again
          </Button>
        </div>
      )
    } else {
      overlay = (
        <div className="log-overlay" role="status">
          <p>Waiting for log lines…</p>
        </div>
      )
    }
  } else if (visible.length === 0) {
    overlay = (
      <div className="log-overlay" role="status">
        <p>No lines at the selected levels.</p>
        <Button size="sm" onClick={() => setLevels([])}>
          Show all levels
        </Button>
      </div>
    )
  }

  const statusText =
    status === 'reconnecting'
      ? `Reconnecting (attempt ${stream.reconnectAttempt})`
      : status === 'paused' && stream.held > 0
        ? `Paused · ${stream.held.toLocaleString()} new lines held`
        : statusLabels[status]

  return (
    <div
      ref={rootRef}
      className={`log-viewer${wrap ? ' is-wrapped' : ''}${fullscreen ? ' is-fullscreen' : ''} ${className}`.trim()}
    >
      <div className="log-toolbar">
        <div className="log-toolbar-row">
          {pickers}
          {!pickers && (
            <span className="log-resource" title={`${kind} ${namespace}/${name}`}>
              <span className="log-resource-kind">{kind}</span>
              <span className="log-resource-name mono">{name}</span>
            </span>
          )}
          {/* One unit, so a narrow toolbar wraps it whole rather than
              stranding a lone control on its own line. */}
          <div className="log-toolbar-group">
            {choosableContainers.length > 1 && (
              <label className="log-field">
                <span>Container</span>
                <select
                  className="select"
                  value={container}
                  onChange={(event) => setContainer(event.target.value)}
                >
                  {choosableContainers.map((item) => (
                    <option key={item.name} value={item.name}>
                      {item.init ? `${item.name} (init)` : item.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="log-field">
              <span>Since</span>
              <select
                className="select"
                value={since}
                onChange={(event) => setSince(event.target.value as SinceOption)}
              >
                {sinceOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="log-field">
              <span>Lines</span>
              <select
                className="select"
                value={tailLines}
                onChange={(event) => setTailLines(Number(event.target.value))}
              >
                {tailOptions.map((option) => (
                  <option key={option} value={option}>
                    {option.toLocaleString()}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {/* Previous sits with the stream controls rather than the pickers: as
              the last picker it was the one item a wrapping row stranded. */}
          <div className="log-toolbar-actions">
            <ToolToggle
              pressed={previous}
              onChange={setPrevious}
              label="Previous container"
              title="Logs from the previous, crashed container instance"
            >
              Previous
            </ToolToggle>
            <span className="log-toolbar-divider" aria-hidden="true" />
            <ToolToggle
              pressed={paused}
              onChange={setPaused}
              label={paused ? 'Resume stream' : 'Pause stream'}
              icon={paused ? <PlayIcon /> : <PauseIcon />}
            />
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon={<DownloadIcon />}
              aria-label="Download logs"
              title="Download logs"
              disabled={lines.length === 0}
              onClick={download}
            />
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon={<CopyIcon />}
              aria-label="Copy visible lines"
              title="Copy visible lines"
              disabled={visible.length === 0}
              onClick={() => void copyVisible()}
            />
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon={<ClearIcon />}
              aria-label="Clear"
              title="Clear the screen; the stream keeps running"
              disabled={lines.length === 0}
              onClick={clearLines}
            />
            {canFullscreen && (
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                icon={fullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
                aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                onClick={toggleFullscreen}
              />
            )}
          </div>
        </div>

        <div className="log-toolbar-row">
          <div className="log-search" data-invalid={matcher.invalid || undefined}>
            <SearchIcon aria-hidden="true" />
            <input
              className="input"
              type="search"
              aria-label="Search logs"
              aria-invalid={matcher.invalid || undefined}
              placeholder={regex ? 'Regular expression' : 'Search logs'}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setActiveMatch(0)
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                goToMatch(event.shiftKey ? currentMatch - 1 : currentMatch + 1)
              }}
            />
            {query && (
              <span className="log-search-count" aria-live="polite">
                {matcher.invalid
                  ? 'Invalid pattern'
                  : matches.length
                    ? `${currentMatch + 1} of ${matches.length.toLocaleString()}`
                    : 'No matches'}
              </span>
            )}
            <button
              type="button"
              className="log-tool log-tool--icon"
              aria-label="Previous match"
              title="Previous match (Shift+Enter)"
              disabled={!matches.length}
              onClick={() => goToMatch(currentMatch - 1)}
            >
              <ChevronUpIcon />
            </button>
            <button
              type="button"
              className="log-tool log-tool--icon"
              aria-label="Next match"
              title="Next match (Enter)"
              disabled={!matches.length}
              onClick={() => goToMatch(currentMatch + 1)}
            >
              <ChevronDownIcon />
            </button>
            <ToolToggle
              pressed={caseSensitive}
              onChange={setCaseSensitive}
              label="Match case"
              icon={<CaseSensitiveIcon />}
            />
            <ToolToggle
              pressed={regex}
              onChange={setRegex}
              label="Regular expression"
              icon={<RegexIcon />}
            />
            <ToolToggle
              pressed={serverFilter}
              onChange={(next) => {
                setServerFilter(next)
                if (!next) setAppliedFilter('')
              }}
              label="Server filter"
              title="Only stream lines containing the search text (plain text, not a pattern)"
            >
              Server filter
            </ToolToggle>
          </div>

          <div className="log-levels" role="group" aria-label="Levels">
            {logLevels.map((level) => (
              <button
                key={level}
                type="button"
                className={`log-level-chip${levels.includes(level) ? ' is-active' : ''}`}
                data-level={level}
                aria-pressed={levels.includes(level)}
                aria-label={`${levelLabels[level]}, ${counts[level]} lines`}
                onClick={() => toggleLevel(level)}
              >
                <i aria-hidden="true" />
                {levelLabels[level]}
                <span className="log-level-count">{counts[level].toLocaleString()}</span>
              </button>
            ))}
          </div>

          <div className="log-toolbar-actions" role="group" aria-label="Display">
            <ToolToggle
              pressed={follow}
              onChange={(next) => (next ? jumpToLatest() : stopFollowing())}
              label="Follow"
              icon={<JumpToLatestIcon />}
              title="Keep the newest line in view"
            >
              Follow
            </ToolToggle>
            <ToolToggle pressed={wrap} onChange={setWrap} label="Wrap lines" icon={<WrapIcon />} />
            <ToolToggle pressed={showTimestamps} onChange={setShowTimestamps} label="Timestamps">
              Time
            </ToolToggle>
            <ToolToggle pressed={showPods} onChange={setShowPods} label="Pod column">
              Pod
            </ToolToggle>
          </div>
        </div>
      </div>

      <div className="log-body">
        {/* Mounted with the first lines: until then the state overlay says
            what is happening, and an empty region would only be noise. */}
        {lines.length > 0 && (
          <div
            ref={scrollRef}
            className={`log-scroll${showTimestamps ? ' has-timestamps' : ''}${showPods ? ' has-pods' : ''}`}
            role="log"
            aria-live="off"
            aria-label={`Live logs for ${name}`}
            style={showPods ? ({ '--pod-width': `${podWidth}ch` } as object) : undefined}
            tabIndex={0}
            onScroll={onScroll}
            onKeyDown={onLogKeyDown}
          >
            {virtualize ? (
              <div className="log-virtual" style={{ height: virtualizer.getTotalSize() }}>
                {virtualizer.getVirtualItems().map((item) => {
                  const line = visible[item.index]
                  return (
                    <div
                      key={item.key}
                      ref={virtualizer.measureElement}
                      data-index={item.index}
                      className={rowClass(line)}
                      style={{ transform: `translateY(${item.start}px)` }}
                    >
                      {renderRow(line, item.index)}
                    </div>
                  )
                })}
              </div>
            ) : (
              visible.map((line, index) => (
                <div key={line.seq} data-index={index} className={rowClass(line)}>
                  {renderRow(line, index)}
                </div>
              ))
            )}
          </div>
        )}
        {overlay}
        {newLines > 0 && (
          <button type="button" className="log-new-pill" onClick={jumpToLatest}>
            {newLines.toLocaleString()} new {newLines === 1 ? 'line' : 'lines'}
            <ChevronDownIcon aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="log-statusbar">
        <span className="log-status" data-status={status}>
          <StatusDot
            tone={statusTones[status]}
            inFlight={status === 'live' || status === 'connecting' || status === 'reconnecting'}
            size="sm"
          />
          {statusText}
        </span>
        <span>Showing the latest {lines.length.toLocaleString()} lines</span>
        {levels.length > 0 && <span>{visible.length.toLocaleString()} at selected levels</span>}
        {!follow && (
          <button type="button" className="link-button log-jump" onClick={jumpToLatest}>
            Jump to latest <Kbd>End</Kbd>
          </button>
        )}
      </div>
    </div>
  )
}
