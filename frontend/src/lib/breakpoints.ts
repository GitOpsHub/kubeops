/**
 * The three layout breakpoints, mirrored by every stylesheet's `@media` rules
 * (styles/guards.test.ts enforces that no other width appears). Components
 * that need to branch in JavaScript read them from here rather than restating
 * the numbers.
 *
 * - sm (≤640): phone. The sidebar becomes a drawer, tables become cards.
 * - md (≤960): tablet. The sidebar collapses to an icon rail.
 * - lg (≤1280): small laptop. Multi-column pages drop a column.
 */
export const breakpoints = {
  sm: 640,
  md: 960,
  lg: 1280,
} as const

export type Breakpoint = keyof typeof breakpoints

/** A media query matching viewports at or below the breakpoint. */
export function maxWidth(breakpoint: Breakpoint) {
  return `(max-width: ${breakpoints[breakpoint]}px)`
}
