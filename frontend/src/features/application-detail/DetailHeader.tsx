import type { ApplicationOnboarding } from '../../api/onboarding'
import { ProviderLogo } from '../../components/BrandIcons'
import { StatusBadge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Menu, MenuItem } from '../../components/ui/Menu'
import { releaseSyncStatus } from './application-detail'

export type DetailAction = 'sync' | 'scale' | 'offboard' | null

type Props = {
  record: ApplicationOnboarding
  action: DetailAction
  onManifests: () => void
  onDeploy: () => void
  onScale: () => void
  onOffboard: () => void
}

/** Identity on the left, the lifecycle actions on the right. */
export function DetailHeader({
  record,
  action,
  onManifests,
  onDeploy,
  onScale,
  onOffboard,
}: Props) {
  const sync = releaseSyncStatus(record.targets)
  const noTargets = record.targets.length === 0
  const offboarded = record.status === 'offboarded'

  return (
    <header className="detail-header">
      <div className="detail-identity">
        <span className="detail-mark" aria-hidden="true">
          <ProviderLogo provider="docker" />
        </span>
        <div className="detail-identity-copy">
          <div className="detail-title-row">
            <h1 id="application-heading">{record.name}</h1>
            <span aria-label={`Application sync: ${sync}`} className="detail-sync">
              <StatusBadge domain="sync" status={sync} />
            </span>
          </div>
          <span className="mono detail-image" title={record.image}>
            {record.image || 'Image not reported'}
          </span>
        </div>
      </div>

      <div className="detail-actions" aria-label="Application actions" role="group">
        <Button
          disabled={noTargets}
          onClick={onManifests}
          icon={
            <svg viewBox="0 0 18 18" aria-hidden="true">
              <path d="M5 2.5h6l3 3v10H5zM11 2.5v3h3M7.5 9h4M7.5 12h4" />
            </svg>
          }
        >
          Manifest
        </Button>
        <Button
          disabled={action !== null || noTargets || offboarded}
          onClick={onScale}
          icon={
            <svg className="scale-horizontal-icon" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M7 8H2m0 0 3-3M2 8l3 3M9 8h5m0 0-3-3m3 3-3 3" />
            </svg>
          }
        >
          Scale
        </Button>
        <Button
          variant="primary"
          disabled={action !== null || noTargets}
          loading={action === 'sync'}
          onClick={onDeploy}
          icon={
            <svg viewBox="0 0 18 18" aria-hidden="true">
              <path d="M14.5 6A6 6 0 1 0 15 11M14.5 6V2.5M14.5 6H11" />
            </svg>
          }
        >
          {action === 'sync' ? 'Deploying…' : offboarded ? 'Deploy again' : 'Deploy'}
        </Button>
        {/* Delete stays out of the primary row, as in Argo CD: an irreversible
            action should not sit one mis-click from Deploy. */}
        <Menu
          trigger={
            <Button iconOnly aria-label="More application actions">
              <svg viewBox="0 0 16 16" aria-hidden="true" className="detail-more-icon">
                <circle cx="3" cy="8" r="1.3" />
                <circle cx="8" cy="8" r="1.3" />
                <circle cx="13" cy="8" r="1.3" />
              </svg>
            </Button>
          }
        >
          <MenuItem
            danger
            disabled={action !== null || offboarded || noTargets}
            onSelect={onOffboard}
          >
            Offboard
          </MenuItem>
        </Menu>
      </div>
    </header>
  )
}
