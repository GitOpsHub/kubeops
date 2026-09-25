import { describe, expect, it } from 'vitest'
import { breadcrumbsFor, routeIdFor } from './navigation'

describe('routeIdFor', () => {
  it.each([
    ['/', '/'],
    ['/clusters', '/clusters'],
    ['/applications', '/applications'],
    ['/applications/new', '/applications/new'],
    // Two applications share one identity, so switching between them does not
    // remount the page or replay its entrance.
    ['/applications/onboarding-1', '/applications/:id'],
    ['/applications/onboarding-2', '/applications/:id'],
    // Unknown routes fall back to their own path.
    ['/nowhere', '/nowhere'],
  ])('%s → %s', (pathname, expected) => {
    expect(routeIdFor(pathname)).toBe(expected)
  })
})

describe('breadcrumbsFor', () => {
  it.each([
    ['/', undefined, [{ label: 'Overview' }]],
    ['/sources', undefined, [{ label: 'Cloud sources' }]],
    [
      '/applications/new',
      undefined,
      [{ label: 'Applications', to: '/applications' }, { label: 'Onboard' }],
    ],
    [
      '/applications/onboarding-1',
      'payments-api',
      [{ label: 'Applications', to: '/applications' }, { label: 'payments-api' }],
    ],
    ['/nowhere', undefined, [{ label: 'Not found' }]],
  ])('%s', (pathname, name, expected) => {
    expect(breadcrumbsFor(pathname, name)).toEqual(expected)
  })
})
