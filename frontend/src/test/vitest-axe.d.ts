import 'vitest'
import type { AxeMatchers } from 'vitest-axe/matchers'

// vitest-axe still augments the pre-v1 global `Vi` namespace, which current
// Vitest no longer reads.
declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
  interface Assertion<T = any> extends AxeMatchers {}
}
