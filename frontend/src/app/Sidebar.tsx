import { Link, useLocation } from 'react-router-dom'
import type { SyncRun } from '../api/inventory'
import { KubernetesLogo } from '../components/BrandIcons'
import { CollapseSidebarIcon, ExpandSidebarIcon } from '../components/icons'
import { Button } from '../components/ui/Button'
import { Tooltip } from '../components/ui/Tooltip'
import { navSections } from './navigation'
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
  const { pathname } = useLocation()
  // The drawer renders its own copy, so heading IDs must not collide with the rail's.
  const idPrefix = onToggleCollapsed ? 'sidebar' : 'drawer'

  return (
    <>
      <div className="sidebar-brand">
        <Tooltip content="KubeOps" side="right" disabled={!collapsed}>
          <Link to="/" aria-label="KubeOps home" onClick={onNavigate}>
            <span className="sidebar-logo-mark">
              <KubernetesLogo className="sidebar-logo" />
            </span>
            <span className="sidebar-label sidebar-brand-copy">
              <span className="sidebar-brand-name">KubeOps</span>
              <span className="sidebar-brand-tagline">Fleet console</span>
            </span>
          </Link>
        </Tooltip>
      </div>

      <nav className="sidebar-nav" aria-label="Primary">
        {navSections.map((section) => (
          <div className="sidebar-section" key={section.id}>
            <span className="sidebar-section-label" id={`${idPrefix}-${section.id}`}>
              {section.label}
            </span>
            <ul aria-labelledby={`${idPrefix}-${section.id}`}>
              {section.items.map((item) => {
                const active = item.isActive(pathname)
                const Icon = item.icon
                return (
                  <li key={item.to}>
                    {/* The label stays in the DOM when collapsed, visually
                        hidden, so the link keeps its accessible name. */}
                    <Tooltip content={item.label} side="right" disabled={!collapsed}>
                      <Link
                        to={item.to}
                        className={active ? 'nav-link is-active' : 'nav-link'}
                        aria-current={active ? 'page' : undefined}
                        onClick={onNavigate}
                      >
                        <span className="nav-icon">
                          <Icon />
                        </span>
                        <span className="sidebar-label">{item.label}</span>
                      </Link>
                    </Tooltip>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        <SyncReadout run={latestRun} unavailable={syncUnavailable} />
        {onToggleCollapsed && (
          <div className="sidebar-controls">
            <Tooltip content="Expand sidebar" side="right" disabled={!collapsed}>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                className="sidebar-collapse"
                aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                aria-expanded={!collapsed}
                title={collapsed ? undefined : 'Collapse sidebar'}
                onClick={onToggleCollapsed}
              >
                {collapsed ? <ExpandSidebarIcon /> : <CollapseSidebarIcon />}
              </Button>
            </Tooltip>
          </div>
        )}
      </div>
    </>
  )
}
