import { Link } from 'react-router-dom'
import type { CloudSource } from '../../api/inventory'
import { ArgoHealthState, ArgoSyncState } from '../../components/ArgoStateIcons'
import { ArgoIcon, ExternalLinkIcon } from '../../components/icons'
import { StatusBadge } from '../../components/ui/Badge'
import { plural } from '../../lib/format'
import { deltaTone, deltaToneColour, rollupState } from '../../lib/status'
import { namespaceLabel, type ApplicationGroup } from './application-groups'
import { EnvironmentTags, PlatformIds } from './PlatformIds'

type Props = {
  groups: ApplicationGroup[]
  sources: Map<string, CloudSource>
}

/**
 * Argo-style cards: the default read, led by the health and sync glyphs. The
 * whole card opens the application (the name link is stretched over it); the
 * Argo CD link sits above that layer.
 */
export function ApplicationTiles({ groups, sources }: Props) {
  return (
    <div className="application-tiles">
      {groups.map((group) => {
        const rollup = rollupState(group.targets)
        const tone = deltaTone(rollup.syncStatus, rollup.healthStatus)
        const namespace = namespaceLabel(group)
        const argoUrl = group.targets.find(
          (target) => target.argoApplicationUrl,
        )?.argoApplicationUrl
        return (
          <article
            className={`application-tile application-tile--${tone}`}
            data-tone={deltaToneColour(tone)}
            key={group.key}
          >
            <header className="application-tile-head">
              <div className="cell-stack">
                <Link
                  className="application-tile-name"
                  to={`/applications/${group.applicationId}`}
                  title={`${group.name} · ${group.applicationId}`}
                >
                  {group.name}
                </Link>
                <small className="mono truncate" title={namespace}>
                  {namespace}
                </small>
              </div>
              <StatusBadge domain="lifecycle" status={group.status} />
            </header>
            <div className="application-tile-states">
              <ArgoHealthState status={rollup.healthStatus} />
              <ArgoSyncState status={rollup.syncStatus} />
            </div>
            <dl className="application-tile-facts">
              <div>
                <dt>Environments</dt>
                <dd>
                  <EnvironmentTags environments={group.environments} />
                </dd>
              </div>
              <div>
                <dt>Regions</dt>
                <dd className="mono truncate" title={group.regions.join(', ')}>
                  {group.regions.length > 0 ? group.regions.join(' · ') : '—'}
                </dd>
              </div>
              <div className="application-tile-fact--wide">
                <dt>Platforms</dt>
                <dd>
                  <PlatformIds ids={group.platformIds} sources={sources} />
                </dd>
              </div>
            </dl>
            <footer className="application-tile-foot">
              <span>{`${plural(group.records.length, 'release')} · ${plural(group.targets.length, 'target')}`}</span>
              {argoUrl && (
                <a
                  className="application-tile-argo"
                  href={argoUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ArgoIcon aria-hidden="true" />
                  Argo CD
                  <ExternalLinkIcon aria-hidden="true" />
                </a>
              )}
            </footer>
          </article>
        )
      })}
    </div>
  )
}
