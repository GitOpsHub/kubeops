import { createContext, useContext, type ReactNode } from 'react'

export type ToastKind = 'success' | 'error' | 'info' | 'loading'

export type ToastOptions = {
  /** A second line under the message. */
  description?: ReactNode
  /** Milliseconds before auto-dismissal; `Infinity` keeps it until dismissed. */
  duration?: number
  /** Replaces an existing toast with the same id instead of stacking. */
  id?: string
}

export type ToastRecord = {
  id: string
  kind: ToastKind
  message: ReactNode
  description?: ReactNode
  duration: number
}

type PromiseMessages<T> = {
  loading: ReactNode
  success: ReactNode | ((value: T) => ReactNode)
  error: ReactNode | ((error: unknown) => ReactNode)
}

export type ToastApi = {
  success: (message: ReactNode, options?: ToastOptions) => string
  error: (message: ReactNode, options?: ToastOptions) => string
  info: (message: ReactNode, options?: ToastOptions) => string
  /**
   * One toast that follows a promise: loading while it runs, then success or
   * error in place. Resolves and rejects exactly as the promise does.
   */
  promise: <T>(promise: Promise<T>, messages: PromiseMessages<T>) => Promise<T>
  dismiss: (id: string) => void
}

export const ToastContext = createContext<ToastApi | null>(null)

/**
 * Transient feedback for an action's outcome. Persistent state and form
 * errors still belong in a `Banner` beside what they describe.
 */
export function useToast(): ToastApi {
  const api = useContext(ToastContext)
  if (!api) throw new Error('useToast needs a ToastProvider above it')
  return api
}
