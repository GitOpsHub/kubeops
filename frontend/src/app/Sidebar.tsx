import { Link, NavLink } from 'react-router-dom'
import type { SyncRun } from '../api/inventory'
import { KubernetesLogo } from '../components/BrandIcons'
import { Button } from '../components/ui/Button'
import { Tooltip } from '../components/ui/Tooltip'
import { CollapseIcon } from './nav-icons'
import { navItems } from './navigation'
import { SyncReadout } from './SyncReadout'

type Props = {
  collapsed: boolean
  onToggleCollapsed?: () => void
  onNavigate?: () => void
  latestRun: SyncRun | null
  syncUnavailable: boolean
}

/**
 * Brand, primary navigation, and the fleet's sync heartbeat. Rendered as the
 * persistent rail on wide screens and inside the mobile drawer, so both share
 * one definition of where things are.
 */
export function SidebarContent({
  collapsed,
  onToggleCollapsed,
  onNavigate,
  latestRun,
  syncUnavailable,
}: Props) {
  return (
    <>
      <div className="sidebar-brand">
        <Link to="/" aria-label="KubeOps home" onClick={onNavigate}>
          <KubernetesLogo className="sidebar-logo" />
          <span className="sidebar-label">KubeOps</span>
        </Link>
      </div>

      <nav className="sidebar-nav" aria-label="Primary">
        <ul>
          {navItems.map((item) => (
            <li key={item.to}>
              {/* The label stays in the DOM when collapsed, visually hidden,
                  so the link keeps its accessible name. */}
              <Tooltip content={item.label} side="right" disabled={!collapsed}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) => (isActive ? 'nav-link is-active' : 'nav-link')}
                  onClick={onNavigate}
                >
                  <span className="nav-icon">{item.icon}</span>
                  <span className="sidebar-label">{item.label}</span>
                </NavLink>
              </Tooltip>
            </li>
          ))}
        </ul>
      </nav>

      <div className="sidebar-footer">
        <SyncReadout run={latestRun} unavailable={syncUnavailable} />
        <div className="sidebar-controls">
          {onToggleCollapsed && (
            <Button
              variant="ghost"
              iconOnly
              className="sidebar-collapse"
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-expanded={!collapsed}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              onClick={onToggleCollapsed}
            >
              <CollapseIcon collapsed={collapsed} />
            </Button>
          )}
        </div>
      </div>
    </>
  )
}
