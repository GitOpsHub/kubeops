import { useCallback, useEffect, useRef, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { refreshStaleSources } from '../api/inventory'
import type { AppShellContext } from '../lib/app-shell'

/**
 * Keeps cloud sources synced while KubeOps is open, so nobody has to press
 * "Sync now". On Vercel the API has no background workers; this is what drives
 * discovery there. The API only discovers sources whose last sync is older
 * than its interval, so every open tab can call it without multiplying work.
 *
 * It asks once on mount, then once per interval the API reports, and skips
 * ticks while the tab is hidden, catching up as soon as it is shown again.
 */

export type AutoSyncState = {
  /** A refresh request is in flight. */
  syncing: boolean
  /** When the latest refresh that actually synced something finished. */
  lastSyncedAt: number | null
  /** The most recent refresh failure, cleared by the next success. */
  error: Error | null
  /** How often each source is due, as the API last reported it. */
  intervalMs: number
}

export const defaultAutoSyncIntervalMs = 5 * 60 * 1000
// Guards against a misconfigured SYNC_INTERVAL turning every tab into a
// request loop.
const minimumIntervalMs = 60 * 1000

export function useAutoSync(onSynced?: () => void): AutoSyncState {
  const [state, setState] = useState<AutoSyncState>({
    syncing: false,
    lastSyncedAt: null,
    error: null,
    intervalMs: defaultAutoSyncIntervalMs,
  })
  const onSyncedRef = useRef(onSynced)
  useEffect(() => {
    onSyncedRef.current = onSynced
  }, [onSynced])

  const hidden = useCallback(
    () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
    [],
  )

  useEffect(() => {
    let disposed = false
    let inFlight = false
    let timer: number | undefined
    let intervalMs = defaultAutoSyncIntervalMs
    let lastAttempt = 0

    const schedule = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void run(), intervalMs)
    }

    const run = async () => {
      if (disposed || inFlight) return
      if (hidden()) {
        // The visibility handler picks this up when the tab returns.
        return
      }
      inFlight = true
      lastAttempt = Date.now()
      setState((current) => ({ ...current, syncing: true }))
      try {
        const result = await refreshStaleSources()
        if (disposed) return
        if (result.intervalSeconds > 0) {
          intervalMs = Math.max(minimumIntervalMs, result.intervalSeconds * 1000)
        }
        const synced = result.items.length > 0
        setState((current) => ({
          syncing: false,
          error: null,
          lastSyncedAt: synced ? Date.now() : current.lastSyncedAt,
          intervalMs,
        }))
        if (synced) onSyncedRef.current?.()
      } catch (error) {
        if (disposed) return
        setState((current) => ({
          ...current,
          syncing: false,
          error: error instanceof Error ? error : new Error(String(error)),
        }))
      } finally {
        inFlight = false
        if (!disposed) schedule()
      }
    }

    const handleVisibility = () => {
      if (!hidden() && !inFlight && Date.now() - lastAttempt >= intervalMs) void run()
    }

    void run()
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      disposed = true
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [hidden])

  return state
}

/**
 * Reloads a page's inventory as soon as the shell's automatic sync discovers
 * something. Outside the shell (a page rendered alone in a test) it is inert.
 */
export function useReloadAfterAutoSync(reload: () => Promise<void>) {
  const lastAutoSyncAt = useOutletContext<AppShellContext | undefined>()?.lastAutoSyncAt ?? null
  const reloadRef = useRef(reload)
  useEffect(() => {
    reloadRef.current = reload
  }, [reload])
  useEffect(() => {
    if (lastAutoSyncAt !== null) void reloadRef.current()
  }, [lastAutoSyncAt])
}

/** How often each source syncs; the default outside the shell. */
export function useSyncInterval() {
  return useOutletContext<AppShellContext | undefined>()?.syncIntervalMs ?? defaultAutoSyncIntervalMs
}
