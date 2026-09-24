import type { ReactNode } from 'react'
import { ApplicationsIcon, ClustersIcon, OverviewIcon, SourcesIcon } from './nav-icons'

export type NavItem = {
  to: string
  label: string
  icon: ReactNode
  /** Only an exact match marks it active (the index route). */
  end?: boolean
}

export const navItems: NavItem[] = [
  { to: '/', label: 'Overview', icon: <OverviewIcon />, end: true },
  { to: '/clusters', label: 'Clusters', icon: <ClustersIcon /> },
  { to: '/applications', label: 'Applications', icon: <ApplicationsIcon /> },
  { to: '/sources', label: 'Cloud sources', icon: <SourcesIcon /> },
]

export type Crumb = { label: string; to?: string }

/** Breadcrumbs from the path, with the application's name when a page gave it. */
export function breadcrumbsFor(pathname: string, applicationName?: string): Crumb[] {
  const [section, detail] = pathname.split('/').filter(Boolean)
  if (!section) return [{ label: 'Overview' }]
  const item = navItems.find((entry) => entry.to === `/${section}`)
  if (!item) return [{ label: 'Not found' }]
  if (!detail) return [{ label: item.label }]
  const crumbs: Crumb[] = [{ label: item.label, to: item.to }]
  if (section === 'applications' && detail === 'new') crumbs.push({ label: 'Onboard' })
  else crumbs.push({ label: applicationName || 'Application' })
  return crumbs
}
