import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, apiUrl, errorMessage, isAbortError, request, requestVoid } from './client'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('api client', () => {
  it('prefixes every path with the one API base URL', () => {
    expect(apiUrl('/clusters')).toMatch(/\/api\/clusters$/)
  })

  it('parses a successful JSON response and forwards the request init', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ items: [1, 2] }))
    const controller = new AbortController()

    await expect(
      request<{ items: number[] }>('/things', { signal: controller.signal }),
    ).resolves.toEqual({ items: [1, 2] })
    expect(fetchMock).toHaveBeenCalledWith(apiUrl('/things'), { signal: controller.signal })
  })

  it.each([
    {
      name: 'uses the backend error message',
      response: () => Response.json({ error: 'database is unavailable' }, { status: 503 }),
      message: 'database is unavailable',
      status: 503,
    },
    {
      name: 'falls back to the status when the body has no error',
      response: () => new Response('<html>bad gateway</html>', { status: 502 }),
      message: 'Request failed with status 502',
      status: 502,
    },
    {
      name: 'keeps 404s distinguishable',
      response: () => Response.json({ error: 'not found' }, { status: 404 }),
      message: 'not found',
      status: 404,
    },
  ])('$name', async ({ response, message, status }) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response())

    const error = await request('/things').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ message, status })
  })

  it('accepts an empty 204 response without parsing it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
    await expect(requestVoid('/things/1', { method: 'DELETE' })).resolves.toBeUndefined()
  })

  it('recognises aborts and extracts messages', () => {
    expect(isAbortError(new DOMException('aborted', 'AbortError'))).toBe(true)
    expect(isAbortError(new Error('nope'))).toBe(false)
    expect(errorMessage(new Error('boom'), 'fallback')).toBe('boom')
    expect(errorMessage('not an error', 'fallback')).toBe('fallback')
  })
})
