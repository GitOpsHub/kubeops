/**
 * Toasts, hand-built rather than Radix Toast: Radix mirrors every toast into
 * a second, visually hidden announcer node, so the same text exists twice and
 * any `findByText` for an outcome message finds two elements.
 *
 * The region is mounted before any toast exists, so assistive technology is
 * already watching it when the first one arrives. Each toast is its own
 * status (or alert, for errors) so it is announced once, as a whole.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CloseIcon, ErrorIcon, InfoIcon, SpinnerIcon, SuccessIcon } from '../icons'
import {
  ToastContext,
  type ToastApi,
  type ToastKind,
  type ToastOptions,
  type ToastRecord,
} from './toast-context'
import './Toast.css'

/** More than this and the oldest is dropped; a wall of toasts reads as noise. */
const maxToasts = 3

const defaultDurations: Record<ToastKind, number> = {
  success: 5_000,
  info: 5_000,
  // Errors carry the detail an operator may need to read twice.
  error: 10_000,
  loading: Infinity,
}

const icons: Record<ToastKind, ReactNode> = {
  success: <SuccessIcon />,
  error: <ErrorIcon />,
  info: <InfoIcon />,
  loading: <SpinnerIcon className="toast-spinner" />,
}

const tones: Record<ToastKind, string> = {
  success: 'ok',
  error: 'err',
  info: 'info',
  loading: 'info',
}

let counter = 0

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([])
  // Hovering or focusing the region holds every timer, so a toast never
  // disappears while someone is reading it or reaching for its button.
  const [paused, setPaused] = useState(false)

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const show = useCallback((kind: ToastKind, message: ReactNode, options: ToastOptions = {}) => {
    const id = options.id ?? `toast-${++counter}`
    const record: ToastRecord = {
      id,
      kind,
      message,
      description: options.description,
      duration: options.duration ?? defaultDurations[kind],
    }
    setToasts((current) => {
      const existing = current.findIndex((toast) => toast.id === id)
      if (existing !== -1) return current.map((toast) => (toast.id === id ? record : toast))
      return [...current, record].slice(-maxToasts)
    })
    return id
  }, [])

  const api = useMemo<ToastApi>(
    () => ({
      success: (message, options) => show('success', message, options),
      error: (message, options) => show('error', message, options),
      info: (message, options) => show('info', message, options),
      dismiss,
      promise: (promise, messages) => {
        const id = show('loading', messages.loading)
        promise.then(
          (value) =>
            show(
              'success',
              typeof messages.success === 'function' ? messages.success(value) : messages.success,
              { id },
            ),
          (error: unknown) =>
            show(
              'error',
              typeof messages.error === 'function' ? messages.error(error) : messages.error,
              { id },
            ),
        )
        return promise
      },
    }),
    [dismiss, show],
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      <section
        className="toast-region"
        aria-label="Notifications"
        onPointerEnter={() => setPaused(true)}
        onPointerLeave={() => setPaused(false)}
        onFocus={() => setPaused(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPaused(false)
        }}
      >
        {/*
         * `aria-live="off"` is not decoration: a modal dialog hides everything
         * outside itself from assistive technology, except elements carrying
         * an `aria-live` attribute. The attribute keeps this list reachable
         * while a dialog is open; "off" leaves announcing to each toast.
         */}
        <ol className="toast-list" aria-live="off">
          {toasts.map((toast) => (
            <ToastItem key={toast.id} toast={toast} paused={paused} onDismiss={dismiss} />
          ))}
        </ol>
      </section>
    </ToastContext.Provider>
  )
}

function ToastItem({
  toast,
  paused,
  onDismiss,
}: {
  toast: ToastRecord
  paused: boolean
  onDismiss: (id: string) => void
}) {
  const remaining = useRef(toast.duration)

  // A toast updated in place (a promise settling) starts its own clock.
  useEffect(() => {
    remaining.current = toast.duration
  }, [toast])

  useEffect(() => {
    if (paused || !Number.isFinite(remaining.current)) return
    const startedAt = Date.now()
    const timer = window.setTimeout(() => onDismiss(toast.id), remaining.current)
    return () => {
      window.clearTimeout(timer)
      remaining.current -= Date.now() - startedAt
    }
  }, [paused, toast, onDismiss])

  // The role sits on an inner element: a list item may not be a live region.
  return (
    <li className="toast-item">
      <div
        className={`toast toast--${toast.kind}`}
        data-tone={tones[toast.kind]}
        role={toast.kind === 'error' ? 'alert' : 'status'}
        aria-atomic="true"
      >
        <span className="toast-icon" aria-hidden="true">
          {icons[toast.kind]}
        </span>
        <div className="toast-copy">
          <p className="toast-message">{toast.message}</p>
          {toast.description && <p className="toast-description">{toast.description}</p>}
        </div>
        <button
          type="button"
          className="toast-dismiss"
          aria-label="Dismiss notification"
          onClick={() => onDismiss(toast.id)}
        >
          <CloseIcon />
        </button>
      </div>
    </li>
  )
}
