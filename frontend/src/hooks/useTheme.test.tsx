import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { themeStorageKey, useTheme } from './useTheme'

function stubMatchMedia(dark: boolean) {
  const listeners = new Set<() => void>()
  const list = {
    get matches() {
      return dark
    },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => list),
  )
  return {
    setDark(next: boolean) {
      dark = next
      listeners.forEach((listener) => listener())
    },
  }
}

describe('useTheme', () => {
  const store = new Map<string, string>()

  beforeEach(() => {
    store.clear()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    })
  })

  afterEach(() => {
    delete document.documentElement.dataset.theme
  })

  it.each([
    { stored: undefined, systemDark: false, preference: 'system', resolved: 'light' },
    { stored: undefined, systemDark: true, preference: 'system', resolved: 'dark' },
    { stored: 'system', systemDark: true, preference: 'system', resolved: 'dark' },
    { stored: 'light', systemDark: true, preference: 'light', resolved: 'light' },
    { stored: 'dark', systemDark: false, preference: 'dark', resolved: 'dark' },
    { stored: 'sepia', systemDark: false, preference: 'system', resolved: 'light' },
  ])(
    'resolves stored $stored with a dark system of $systemDark to $resolved',
    ({ stored, systemDark, preference, resolved }) => {
      if (stored) store.set(themeStorageKey, stored)
      stubMatchMedia(systemDark)

      const { result } = renderHook(() => useTheme())

      expect(result.current.preference).toBe(preference)
      expect(result.current.resolved).toBe(resolved)
      expect(document.documentElement.dataset.theme).toBe(resolved)
    },
  )

  it('follows the system while the preference is system, and stops once one is chosen', () => {
    const media = stubMatchMedia(false)
    const { result } = renderHook(() => useTheme())

    act(() => media.setDark(true))
    expect(result.current.resolved).toBe('dark')

    act(() => result.current.setPreference('light'))
    expect(store.get(themeStorageKey)).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')

    act(() => media.setDark(false))
    act(() => media.setDark(true))
    expect(result.current.resolved).toBe('light')
  })

  it('keeps every consumer in agreement', () => {
    stubMatchMedia(false)
    const first = renderHook(() => useTheme())
    const second = renderHook(() => useTheme())

    act(() => first.result.current.setPreference('dark'))

    expect(second.result.current.preference).toBe('dark')
    expect(second.result.current.resolved).toBe('dark')
  })

  it('still switches for the session when storage is blocked', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    })
    const { result } = renderHook(() => useTheme())

    act(() => result.current.setPreference('dark'))
    expect(result.current.resolved).toBe('dark')

    // Leaves the in-memory fallback as it found it for later tests.
    act(() => result.current.setPreference('system'))
  })
})
