import '@testing-library/jest-dom/vitest'
import { afterEach, expect, vi } from 'vitest'
import * as axeMatchers from 'vitest-axe/matchers'

expect.extend(axeMatchers)

afterEach(() => {
  // Preferences are browser state, so they must not leak between otherwise
  // independent tests. Restore any test-specific storage stub before clearing
  // the jsdom implementation used by CI.
  vi.unstubAllGlobals()
  for (const storage of ['localStorage', 'sessionStorage'] as const) {
    try {
      window[storage].clear()
    } catch {
      // Some Node environments expose storage without a configured backing
      // file. Production code guards the same unavailable-storage case.
    }
  }
})
