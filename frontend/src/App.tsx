import { useState } from 'react'
import { Link, NavLink, Outlet, Route, Routes } from 'react-router-dom'
import type { SyncRun } from './api/inventory'
import { KubernetesLogo } from './components/BrandIcons'
import { FleetDashboard } from './components/FleetDashboard'
import { ApplicationsList } from './components/ApplicationsList'
import { ApplicationOnboardingForm } from './components/ApplicationOnboardingForm'
import { ApplicationDetail } from './components/ApplicationDetail'
import { ThemeToggle } from './components/ThemeToggle'

function navClass({ isActive }: { isActive: boolean }) {
  return `primary-nav-link ${isActive ? 'is-active' : ''}`
}

function relativeTime(value: string) {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000)
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  if (Math.abs(seconds) < 60) return formatter.format(seconds, 'second')
  const minutes = Math.round(seconds / 60)
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute')
  return formatter.format(Math.round(minutes / 60), 'hour')
}

function AppShell() {
  const [latestRun, setLatestRun] = useState<SyncRun | null>(null)

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <Link className="header-brand" to="/" aria-label="KubeOps home">
          <KubernetesLogo className="brand-mark" />
          <strong>KubeOps</strong>
        </Link>
        <nav className="primary-nav" aria-label="Primary">
          <NavLink to="/" end className={navClass}>
            Fleet
          </NavLink>
          <NavLink to="/applications" className={navClass}>
            Applications
          </NavLink>
        </nav>
        <div className="topbar-actions">
          <div className="sync-readout">
            <span className={`sync-dot sync-dot--${latestRun?.status || 'idle'}`} />
            <div>
              <strong>
                {latestRun
                  ? latestRun.status === 'succeeded'
                    ? 'Synced'
                    : `Sync ${latestRun.status}`
                  : 'Awaiting sync'}
              </strong>
              <span>{latestRun ? relativeTime(latestRun.queuedAt) : 'No activity yet'}</span>
            </div>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <main className="dashboard-content" id="main">
        <Outlet context={{ onLatestRunChange: setLatestRun }} />
      </main>
    </div>
  )
}

function RouteNotFound() {
  return (
    <div className="empty-panel" role="status">
      <strong>Page not found</strong>
      <span>
        Go back to the <Link to="/">fleet inventory</Link>.
      </span>
    </div>
  )
}

function App() {
  return (
    <Routes>
      <Route path="/" element={<AppShell />}>
        <Route index element={<FleetDashboard />} />
        <Route path="applications" element={<ApplicationsList />} />
        <Route path="applications/new" element={<ApplicationOnboardingForm />} />
        <Route path="applications/:id" element={<ApplicationDetail />} />
        <Route path="*" element={<RouteNotFound />} />
      </Route>
    </Routes>
  )
}

export default App
