import type { ApplicationDeployment } from '../api/onboarding'
import { deltaTone, groupByRegion } from '../lib/status'
import { StateDelta } from './StateDelta'
import { StatusBadge } from './StatusBadge'

/**
 * Deployment targets grouped by release scope. Environment and region stay
 * together because the pair is the deployment identity shown throughout the UI.
 */

const toneClass: Record<string, string> = {
  converged: 'region-target--ok',
  reconciling: 'region-target--warn',
  diverged: 'region-target--err',
  unknown: '',
}

type Props = {
  targets: ApplicationDeployment[]
  environment: string
  /** Values commit the whole onboarding is pinned to; shown once per group. */
  revision?: string
  /** The parent release card may already display the environment and region. */
  showScopeName?: boolean
}

export function RegionGroups({
  targets,
  environment,
  revision,
  showScopeName = true,
}: Props) {
  const groups = groupByRegion(targets)

  return (
    <div className="region-groups">
      {groups.map((group) => (
        <section
          className="region-group"
          key={group.region}
          aria-label={`Deployment scope ${environment}-${group.region}`}
        >
          <div className="region-group-heading">
            {showScopeName && <strong>{environment}-{group.region}</strong>}
            <span>
              {group.targets.length} {group.targets.length === 1 ? 'cluster' : 'clusters'}
            </span>
            {revision && <span className="revision-tag">values {revision.slice(0, 7)}</span>}
          </div>
          <div className="region-targets">
            {group.targets.map((target) => (
              <article
                className={`region-target ${
                  toneClass[deltaTone(target.syncStatus, target.healthStatus)]
                }`}
                key={target.id}
                aria-label={`Target ${target.clusterName}`}
              >
                <header>
                  <strong title={target.clusterName}>{target.clusterName}</strong>
                  <StatusBadge status={target.status} />
                </header>
                <StateDelta syncStatus={target.syncStatus} healthStatus={target.healthStatus} />
                <div className="region-target-meta">
                  <span className="revision-tag" title={target.argoApplication}>
                    {target.argoApplication}
                  </span>
                  {target.argoApplicationUrl && (
                    <a href={target.argoApplicationUrl} target="_blank" rel="noreferrer">
                      Open in Argo CD
                    </a>
                  )}
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
