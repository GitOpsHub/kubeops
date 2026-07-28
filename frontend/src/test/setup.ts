import '@testing-library/jest-dom/vitest'
import { afterEach, vi } from 'vitest'

afterEach(() => {
  // Preferences are browser state, so they must not leak between otherwise
  // independent tests. Restore any test-specific storage stub before clearing
  // the jsdom implementation used by CI.
  vi.unstubAllGlobals()
  try {
    window.localStorage.clear()
  } catch {
    // Some Node environments expose localStorage without a configured backing
    // file. Production code guards the same unavailable-storage case.
  }
})
