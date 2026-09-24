/**
 * The one HTTP client every API module goes through, so the base URL, error
 * parsing, and the `ApiError` a caller can branch on (404 vs everything else)
 * are defined once rather than copied into each module.
 */

export const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080/api'

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export function apiUrl(path: string) {
  return `${apiBaseUrl}${path}`
}

/** Throws an `ApiError` carrying the backend's `{ error }` message when present. */
export async function ensureOk(response: Response) {
  if (response.ok) return response
  const body = (await response.json().catch(() => ({}))) as { error?: string }
  throw new ApiError(body.error || `Request failed with status ${response.status}`, response.status)
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await ensureOk(await fetch(apiUrl(path), init))
  return response.json() as Promise<T>
}

/** Like `request`, for endpoints that answer with no body (204). */
export async function requestVoid(path: string, init?: RequestInit): Promise<void> {
  await ensureOk(await fetch(apiUrl(path), init))
}

export function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}
