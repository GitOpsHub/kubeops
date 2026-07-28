import { Link, NavLink, Outlet, Route, Routes } from 'react-router-dom'
import { KubernetesLogo } from './components/BrandIcons'
import { FleetDashboard } from './components/FleetDashboard'
import { ApplicationsList } from './components/ApplicationsList'
import { ApplicationOnboardingForm } from './components/ApplicationOnboardingForm'
import { ApplicationDetail } from './components/ApplicationDetail'
import { ThemeToggle } from './components/ThemeToggle'

function navClass({ isActive }: { isActive: boolean }) {
  return `primary-nav-link ${isActive ? 'is-active' : ''}`
}

function AppShell() {
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
          <ThemeToggle />
        </div>
      </header>

      <main className="dashboard-content" id="main">
        <Outlet />
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
