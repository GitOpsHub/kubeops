import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'

export const zoomStep = 0.1
export const minZoom = 0.4
export const maxZoom = 1.6
/** Matches the `.graph-scroll` padding, so "fit" leaves the same gutter. */
const canvasPadding = 24
const canvasBottomPadding = 56
/* Trackpad pinches arrive as ctrl+wheel with small deltas; this keeps a
   pinch and a mouse-wheel notch feeling similar. */
const wheelSensitivity = 0.0025

export function clampZoom(value: number) {
  return Math.min(maxZoom, Math.max(minZoom, value))
}

type Anchor = { x: number; y: number }

type Options = {
  contentWidth: number
  contentHeight: number
  /** Changing this re-fits the canvas, e.g. when a filter changes what is shown. */
  fitKey: string
}

/**
 * Pan and zoom for a scrollable canvas drawn at `scale(zoom)`. Panning moves
 * the scroll position, so the scrollbars, arrow keys, and trackpad scrolling
 * all keep working alongside the drag.
 */
export function usePanZoom({ contentWidth, contentHeight, fitKey }: Options) {
  const [zoom, setZoom] = useState(1)
  // Once the operator picks a zoom, the canvas stops re-fitting itself on every
  // resize — otherwise their choice would be undone by a sidebar opening.
  const [pinned, setPinned] = useState(false)
  const [panning, setPanning] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const sizerRef = useRef<HTMLDivElement | null>(null)
  const zoomRef = useRef(zoom)
  const anchorRef = useRef<{ contentX: number; contentY: number; view: Anchor } | null>(null)
  const dragRef = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(
    null,
  )

  const fit = useCallback(() => {
    const viewport = scrollRef.current
    if (!viewport || contentWidth === 0 || contentHeight === 0) return
    const availableWidth = viewport.clientWidth - canvasPadding * 2
    const availableHeight = viewport.clientHeight - canvasPadding - canvasBottomPadding
    anchorRef.current = null
    // Never magnifies: a two-node graph blown up to fill the panel looks broken.
    setZoom(clampZoom(Math.min(1, availableWidth / contentWidth, availableHeight / contentHeight)))
  }, [contentHeight, contentWidth])

  // Opens fitted rather than clipped, re-fits whenever the filter changes what
  // is drawn, and follows the panel as it resizes until the operator zooms.
  const [fittedKey, setFittedKey] = useState(fitKey)
  if (fittedKey !== fitKey) {
    setFittedKey(fitKey)
    setPinned(false)
  }
  useLayoutEffect(() => {
    if (!pinned) fit()
  }, [fit, pinned, fitKey])

  useEffect(() => {
    const viewport = scrollRef.current
    // Re-fitting on resize is an enhancement on top of the fit that already
    // ran on mount, so an environment without the observer simply keeps it.
    if (!viewport || pinned || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => fit())
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [fit, pinned])

  // Keeps the point under the cursor (or the viewport centre) still while the
  // scale changes, instead of everything sliding towards the top-left corner.
  useLayoutEffect(() => {
    zoomRef.current = zoom
    const anchor = anchorRef.current
    const viewport = scrollRef.current
    const sizer = sizerRef.current
    anchorRef.current = null
    if (!anchor || !viewport || !sizer) return
    viewport.scrollLeft = anchor.contentX * zoom + sizer.offsetLeft - anchor.view.x
    viewport.scrollTop = anchor.contentY * zoom + sizer.offsetTop - anchor.view.y
  }, [zoom])

  const zoomTo = useCallback((next: (current: number) => number, anchor?: Anchor) => {
    const viewport = scrollRef.current
    const sizer = sizerRef.current
    const current = zoomRef.current
    const target = clampZoom(next(current))
    if (target === current) return
    if (viewport && sizer) {
      const view = anchor ?? { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 }
      anchorRef.current = {
        contentX: (viewport.scrollLeft + view.x - sizer.offsetLeft) / current,
        contentY: (viewport.scrollTop + view.y - sizer.offsetTop) / current,
        view,
      }
    }
    setPinned(true)
    setZoom(target)
  }, [])

  const zoomBy = useCallback(
    (delta: number) => zoomTo((current) => Math.round((current + delta) * 10) / 10),
    [zoomTo],
  )

  const resetFit = useCallback(() => {
    setPinned(false)
    fit()
  }, [fit])

  // React registers wheel listeners as passive, and a passive listener cannot
  // stop the browser zooming the whole page on ctrl+wheel.
  useEffect(() => {
    const viewport = scrollRef.current
    if (!viewport) return
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const bounds = viewport.getBoundingClientRect()
      const factor = Math.exp(-event.deltaY * wheelSensitivity)
      zoomTo((current) => current * factor, {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      })
    }
    viewport.addEventListener('wheel', onWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', onWheel)
  }, [zoomTo])

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    // Cards, menus, and controls keep their own clicks; only the background drags.
    if ((event.target as Element).closest('button, a, input, select, [role="menu"]')) return
    const viewport = event.currentTarget
    viewport.setPointerCapture?.(event.pointerId)
    dragRef.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: viewport.scrollLeft,
      top: viewport.scrollTop,
    }
    setPanning(true)
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag || drag.id !== event.pointerId) return
    event.currentTarget.scrollLeft = drag.left - (event.clientX - drag.x)
    event.currentTarget.scrollTop = drag.top - (event.clientY - drag.y)
  }

  function endPan(event: PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.id !== event.pointerId) return
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    dragRef.current = null
    setPanning(false)
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Ctrl/⌘ with +/− is the browser's own page zoom; leave it alone.
    if (event.ctrlKey || event.metaKey || event.altKey) return
    if ((event.target as Element).closest('input, select, textarea')) return
    if (event.key === '+' || event.key === '=') zoomBy(zoomStep)
    else if (event.key === '-' || event.key === '_') zoomBy(-zoomStep)
    else if (event.key === '0') resetFit()
    else return
    event.preventDefault()
  }

  return {
    zoom,
    panning,
    scrollRef,
    sizerRef,
    zoomBy,
    resetFit,
    canvasHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endPan,
      onPointerCancel: endPan,
      onKeyDown,
    },
  }
}
