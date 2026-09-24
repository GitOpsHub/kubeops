import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { getSyncRuns } from '../api/inventory'
import { Dialog, DialogTitle } from '../components/ui/Dialog'
import { usePolledResource } from '../hooks/usePolledResource'
import { useStoredPreference } from '../hooks/useStoredPreference'
import type { ApplicationTopbarState, AppShellContext } from '../lib/app-shell'
import { AppHeader } from './AppHeader'
import { ErrorBoundary } from './ErrorBoundary'
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
  const [drawerOpen, setDrawerOpen] = useState(false)
  const collapsed = sidebar === 'collapsed'

  // The shell owns the sync heartbeat so it is live on every page, not only
  // on the one that happens to list sync runs.
  const loadRuns = useCallback((signal: AbortSignal) => getSyncRuns(signal), [])
  const runs = usePolledResource(loadRuns, { intervalMs: syncPollMs })
  const latestRun = runs.data?.[0] ?? null

  // A route change always lands with the drawer closed.
  useEffect(() => setDrawerOpen(false), [pathname])

  const outletContext = useMemo<AppShellContext>(
    () => ({ setApplicationTopbar, refreshSyncStatus: runs.reload }),
    [runs.reload],
  )

  return (
    <div className={collapsed ? 'app-shell is-collapsed' : 'app-shell'}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <aside className="sidebar" aria-label="Sidebar">
        <SidebarContent
          collapsed={collapsed}
          onToggleCollapsed={() => setSidebar(collapsed ? 'expanded' : 'collapsed')}
          latestRun={latestRun}
          syncUnavailable={Boolean(runs.error)}
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
          syncUnavailable={Boolean(runs.error)}
        />
      </Dialog>

      <div className="app-main">
        <AppHeader
          applicationName={applicationTopbar?.name}
          latestRun={latestRun}
          onOpenNavigation={() => setDrawerOpen(true)}
        />
        <main className="app-content" id="main" tabIndex={-1}>
          <ErrorBoundary resetKey={pathname}>
            <Suspense fallback={<RouteFallback />}>
              <Outlet context={outletContext} />
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
    </div>
  )
}
