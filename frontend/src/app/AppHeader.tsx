import { Link, useLocation } from 'react-router-dom'
import type { SyncRun } from '../api/inventory'
import { Button } from '../components/ui/Button'
import { relativeTime } from '../lib/format'
import { breadcrumbsFor } from './navigation'
import { MenuIcon } from './nav-icons'

type Props = {
  applicationName?: string
  latestRun: SyncRun | null
  onOpenNavigation: () => void
}

export function AppHeader({ applicationName, latestRun, onOpenNavigation }: Props) {
  const { pathname } = useLocation()
  const crumbs = breadcrumbsFor(pathname, applicationName)

  return (
    <header className="app-header">
      <Button
        variant="ghost"
        iconOnly
        className="app-header-menu"
        aria-label="Open navigation"
        onClick={onOpenNavigation}
      >
        <MenuIcon />
      </Button>

      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <ol>
          {crumbs.map((crumb, index) => {
            const last = index === crumbs.length - 1
            return (
              <li key={`${crumb.label}-${index}`}>
                {crumb.to && !last ? (
                  <Link to={crumb.to}>{crumb.label}</Link>
                ) : (
                  <span aria-current={last ? 'page' : undefined} className="truncate">
                    {crumb.label}
                  </span>
                )}
              </li>
            )
          })}
        </ol>
      </nav>

      <Link className="app-header-sync" to="/sources" title="Cloud source sync activity">
        <span className={`sync-dot sync-dot--${latestRun?.status ?? 'idle'}`} aria-hidden="true" />
        {latestRun ? `Last sync ${relativeTime(latestRun.queuedAt)}` : 'No sync yet'}
      </Link>
    </header>
  )
}
