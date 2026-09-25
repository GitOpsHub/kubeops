import type { ApplicationOnboarding } from '../../api/onboarding'
import { KubernetesLogo } from '../../components/BrandIcons'
import { DeploymentTargetLogo } from '../../components/DeploymentTargetLogo'
import { ManifestIcon, MoreIcon, ScaleIcon, SyncIcon } from '../../components/icons'
import { StatusBadge, Tag } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Menu, MenuItem } from '../../components/ui/Menu'
import { environmentTone } from '../../lib/status'
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
  // The mark is where the release runs, not what it is built from: a release
  // spans one provider in practice, so its first target speaks for it.
  const firstTarget = record.targets[0]

  return (
    <header className="detail-header">
      <div className="detail-identity">
        <span className="detail-mark" aria-hidden="true">
          {firstTarget ? <DeploymentTargetLogo target={firstTarget} /> : <KubernetesLogo />}
        </span>
        <div className="detail-identity-copy">
          <h1 id="application-heading">{record.name}</h1>
          <div className="detail-tags">
            <span className="tag detail-env" data-tone={environmentTone(record.environment)}>
              {record.environment}
            </span>
            <Tag mono title="Region">
              {record.region}
            </Tag>
            {/* One text node, so the namespace reads as a label here and the
                target cards keep the bare name to themselves. */}
            <Tag mono title="Kubernetes namespace">{`ns/${record.namespace}`}</Tag>
          </div>
          <span className="mono detail-image" title={record.image}>
            {record.image || 'Image not reported'}
          </span>
        </div>
      </div>

      <div className="detail-actions" aria-label="Application actions" role="group">
        <span role="img" aria-label={`Application sync: ${sync}`} className="detail-sync">
          {/* An explicit label keeps "Out of Sync" as written rather than
              letting the badge title-case a value it only differs from in case. */}
          <StatusBadge domain="sync" status={sync} label={sync} />
        </span>
        <Button disabled={noTargets} onClick={onManifests} icon={<ManifestIcon />}>
          Manifest
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
        <Button
          disabled={action !== null || noTargets || offboarded}
          onClick={onScale}
          icon={<ScaleIcon />}
        >
          Scale
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
