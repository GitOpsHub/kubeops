import type { ApplicationOnboarding } from '../../api/onboarding'
import { ProviderLogo } from '../../components/BrandIcons'
import { ManifestIcon, MoreIcon, ScaleIcon, SyncIcon } from '../../components/icons'
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
        <Button disabled={noTargets} onClick={onManifests} icon={<ManifestIcon />}>
          Manifest
        </Button>
        <Button
          disabled={action !== null || noTargets || offboarded}
          onClick={onScale}
          icon={<ScaleIcon />}
        >
          Scale
        </Button>
        <Button
          variant="primary"
          disabled={action !== null || noTargets}
          loading={action === 'sync'}
          onClick={onDeploy}
          icon={<SyncIcon />}
        >
          {action === 'sync' ? 'Deploying…' : offboarded ? 'Deploy again' : 'Deploy'}
        </Button>
        {/* Delete stays out of the primary row, as in Argo CD: an irreversible
            action should not sit one mis-click from Deploy. */}
        <Menu
          trigger={
            <Button iconOnly aria-label="More application actions">
              <MoreIcon />
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
