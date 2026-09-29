import '@testing-library/jest-dom/vitest'
import { configure } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// Routes are lazy-loaded, so the first findBy on a page waits for its chunk to
// be transformed. The 1s default flakes when the suite runs in parallel on a
// busy machine.
configure({ asyncUtilTimeout: 3000 })

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
