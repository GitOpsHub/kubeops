import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { getSyncRuns } from '../api/inventory'
import { Dialog, DialogTitle } from '../components/ui/Dialog'
import { useHotkey } from '../hooks/useHotkey'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { usePolledResource } from '../hooks/usePolledResource'
import { useStoredPreference } from '../hooks/useStoredPreference'
import type { ApplicationTopbarState, AppShellContext } from '../lib/app-shell'
import { maxWidth } from '../lib/breakpoints'
import { AppHeader } from './AppHeader'
import { CommandPalette } from './CommandPalette'
import { ErrorBoundary } from './ErrorBoundary'
import { routeIdFor } from './navigation'
import { RouteFallback } from './RouteFallback'
import { SidebarContent } from './Sidebar'
import './shell.css'

const syncPollMs = 30_000

export function AppShell() {
  const { pathname } = useLocation()
  const [applicationTopbar, setApplicationTopbar] = useState<ApplicationTopbarState | null>(null)
  const [sidebar, setSidebar] = useStoredPreference<'expanded' | 'collapsed'>(
    'kubeops.sidebar',
    'expanded',
  )
  // A tablet gets the icon rail regardless of the stored choice, and opening
  // it there is a moment's decision rather than a preference: writing it to
  // storage would leave the desktop layout collapsed or expanded by accident.
  const isTablet = useMediaQuery(maxWidth('md'))
  const [tabletExpanded, setTabletExpanded] = useState(false)
  const collapsed = isTablet ? !tabletExpanded : sidebar === 'collapsed'
  const toggleCollapsed = () => {
    if (isTablet) setTabletExpanded(collapsed)
    else setSidebar(collapsed ? 'expanded' : 'collapsed')
  }

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  useHotkey('k', () => setPaletteOpen((open) => !open))

  // The shell owns the sync heartbeat so it is live on every page, not only
  // on the one that happens to list sync runs.
  const loadRuns = useCallback((signal: AbortSignal) => getSyncRuns(signal), [])
  const runs = usePolledResource(loadRuns, { intervalMs: syncPollMs })
  const recentRuns = runs.data ?? []
  const latestRun = recentRuns[0] ?? null
  const syncUnavailable = Boolean(runs.error)

  // A route change always lands with the drawer closed.
  useEffect(() => setDrawerOpen(false), [pathname])

  const outletContext = useMemo<AppShellContext>(
    () => ({ setApplicationTopbar, refreshSyncStatus: runs.reload }),
    [runs.reload],
  )
  const refreshSyncStatus = runs.reload
  const onSyncQueued = useCallback(() => void refreshSyncStatus(), [refreshSyncStatus])

  return (
    <div className={collapsed ? 'app-shell is-collapsed' : 'app-shell'}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <aside className="sidebar" aria-label="Sidebar">
        <SidebarContent
          collapsed={collapsed}
          onToggleCollapsed={toggleCollapsed}
          latestRun={latestRun}
          syncUnavailable={syncUnavailable}
        />
      </aside>

      {/* Below the sidebar breakpoint the same content opens as a drawer. */}
      <Dialog
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        variant="drawer"
        className="sidebar sidebar--drawer"
        describedBy={false}
      >
        <DialogTitle className="sr-only">Navigation</DialogTitle>
        <SidebarContent
          collapsed={false}
          onNavigate={() => setDrawerOpen(false)}
          latestRun={latestRun}
          syncUnavailable={syncUnavailable}
        />
      </Dialog>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onSyncQueued={onSyncQueued}
      />

      <div className="app-main">
        <AppHeader
          applicationName={applicationTopbar?.name}
          runs={recentRuns}
          syncUnavailable={syncUnavailable}
          onOpenNavigation={() => setDrawerOpen(true)}
          onOpenCommandPalette={() => setPaletteOpen(true)}
        />
        <main className="app-content" id="main" tabIndex={-1}>
          <ErrorBoundary resetKey={pathname}>
            <Suspense fallback={<RouteFallback />}>
              {/* Keyed on the route pattern, not the pathname: moving between
                  two applications keeps the page mounted and does not replay
                  the entrance. */}
              <div className="route-enter" key={routeIdFor(pathname)}>
                <Outlet context={outletContext} />
              </div>
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
    </div>
  )
}
