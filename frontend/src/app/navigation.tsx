import { matchRoutes } from 'react-router-dom'
import {
  ApplicationsIcon,
  CloudIcon,
  ClusterIcon,
  OverviewIcon,
  PlusIcon,
  type IconComponent,
} from '../components/icons'

export type NavItem = {
  to: string
  label: string
  icon: IconComponent
  /** Extra words the command palette matches on. */
  keywords?: string[]
  /**
   * Whether this item is the current page. Written out rather than left to
   * NavLink's prefix match: /applications/new belongs to "Onboard
   * application", not to "Applications" as well.
   */
  isActive: (pathname: string) => boolean
}

export type NavSection = { id: string; label: string; items: NavItem[] }

function under(base: string, pathname: string) {
  return pathname === base || pathname.startsWith(`${base}/`)
}

export const navSections: NavSection[] = [
  {
    id: 'operate',
    label: 'Operate',
    items: [
      {
        to: '/',
        label: 'Overview',
        icon: OverviewIcon,
        keywords: ['home', 'dashboard'],
        isActive: (pathname) => pathname === '/',
      },
      {
        to: '/applications',
        label: 'Applications',
        icon: ApplicationsIcon,
        keywords: ['apps', 'releases', 'deployments'],
        isActive: (pathname) =>
          under('/applications', pathname) && pathname !== '/applications/new',
      },
      {
        to: '/applications/new',
        label: 'Onboard application',
        icon: PlusIcon,
        keywords: ['new', 'create', 'add'],
        isActive: (pathname) => pathname === '/applications/new',
      },
    ],
  },
  {
    id: 'inventory',
    label: 'Inventory',
    items: [
      {
        to: '/clusters',
        label: 'Clusters',
        icon: ClusterIcon,
        keywords: ['kubernetes', 'fleet', 'inventory'],
        isActive: (pathname) => under('/clusters', pathname),
      },
      {
        to: '/sources',
        label: 'Cloud sources',
        icon: CloudIcon,
        keywords: ['providers', 'accounts', 'sync', 'discovery'],
        isActive: (pathname) => under('/sources', pathname),
      },
    ],
  },
]

export const navItems: NavItem[] = navSections.flatMap((section) => section.items)

// Mirrors the child routes in App.tsx. Only used to name the matched route, so
// a route missing here still renders — it just keys its transition on the
// pathname instead.
const routePatterns = [
  { path: '/' },
  { path: '/clusters' },
  { path: '/sources' },
  { path: '/applications' },
  { path: '/applications/new' },
  { path: '/applications/:id' },
  { path: '/applications/:id/logs' },
]

/**
 * A stable identity for the page on screen: the matched route pattern, not
 * the pathname, so moving between two applications (or two releases of one)
 * keeps the page mounted and does not replay its entrance.
 */
export function routeIdFor(pathname: string) {
  const matches = matchRoutes(routePatterns, pathname)
  return matches?.[matches.length - 1]?.route.path ?? pathname
}

export type Crumb = { label: string; to?: string }

/** Breadcrumbs from the path, with the application's name when a page gave it. */
export function breadcrumbsFor(pathname: string, applicationName?: string): Crumb[] {
  const [section, detail, view] = pathname.split('/').filter(Boolean)
  if (!section) return [{ label: 'Overview' }]
  const item = navItems.find((entry) => entry.to === `/${section}`)
  if (!item) return [{ label: 'Not found' }]
  if (!detail) return [{ label: item.label }]
  const crumbs: Crumb[] = [{ label: item.label, to: item.to }]
  if (section === 'applications' && detail === 'new') crumbs.push({ label: 'Onboard' })
  else if (section === 'applications' && view === 'logs') {
    crumbs.push({ label: applicationName || 'Application', to: `/applications/${detail}` })
    crumbs.push({ label: 'Logs' })
  } else crumbs.push({ label: applicationName || 'Application' })
  return crumbs
}
