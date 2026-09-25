import { Link, useLocation } from 'react-router-dom'
import type { SyncRun } from '../api/inventory'
import { ChevronRightIcon, MenuIcon, SearchIcon } from '../components/icons'
import { Button } from '../components/ui/Button'
import { Kbd } from '../components/ui/Kbd'
import { modifierKeyLabel } from '../hooks/useHotkey'
import { breadcrumbsFor } from './navigation'
import { SyncStatusMenu } from './SyncStatusMenu'
import { ThemeMenu } from './ThemeMenu'

type Props = {
  applicationName?: string
  runs: SyncRun[]
  syncUnavailable: boolean
  onOpenNavigation: () => void
  onOpenCommandPalette: () => void
}

export function AppHeader({
  applicationName,
  runs,
  syncUnavailable,
  onOpenNavigation,
  onOpenCommandPalette,
}: Props) {
  const { pathname } = useLocation()
  const crumbs = breadcrumbsFor(pathname, applicationName)
  const modifier = modifierKeyLabel()

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
                {index > 0 && <ChevronRightIcon className="breadcrumb-separator" />}
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

      <div className="app-header-actions">
        <button
          type="button"
          className="command-trigger"
          onClick={onOpenCommandPalette}
          aria-haspopup="dialog"
          aria-keyshortcuts="Meta+K Control+K"
        >
          <SearchIcon className="command-trigger-icon" />
          <span className="command-trigger-label">Search…</span>
          <span className="command-trigger-keys" aria-hidden="true">
            <Kbd>{modifier}</Kbd>
            <Kbd>K</Kbd>
          </span>
        </button>
        <SyncStatusMenu runs={runs} unavailable={syncUnavailable} />
        <ThemeMenu />
      </div>
    </header>
  )
}
