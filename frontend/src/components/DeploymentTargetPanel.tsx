import type { ApplicationDeployment } from '../api/onboarding'
import type { Provider } from '../api/inventory'
import { KubernetesLogo, ProviderLogo } from './BrandIcons'
import { StateDelta } from './StateDelta'
import { StatusBadge } from './StatusBadge'

type Props = {
  target: ApplicationDeployment
}

function targetProvider(target: ApplicationDeployment): Provider | null {
  const fingerprint =
    `${target.sourceId} ${target.providerResourceId} ${target.clusterName}`.toLowerCase()
  if (fingerprint.includes('minikube')) return 'minikube'
  if (fingerprint.includes('docker')) return 'docker'
  if (fingerprint.includes('azure') || fingerprint.includes('aks')) return 'azure'
  if (fingerprint.includes('google') || fingerprint.includes('gke') || fingerprint.includes('gcp')) {
    return 'gcp'
  }
  if (fingerprint.includes('amazon') || fingerprint.includes('eks') || fingerprint.includes('aws')) {
    return 'aws'
  }
  return null
}

export function DeploymentTargetLogo({ target }: Props) {
  const provider = targetProvider(target)
  return (
    <span className="deployment-target-logo" aria-hidden="true">
      {provider ? (
        <ProviderLogo provider={provider} className="provider-logo" />
      ) : (
        <KubernetesLogo className="provider-logo" />
      )}
    </span>
  )
}

/**
 * Renders one Argo CD deployment target. The link is served by the backend's Argo CD
 * proxy, which attaches the API token, so this panel never handles Argo CD
 * credentials at all.
 */
export function DeploymentTargetPanel({ target }: Props) {
  return (
    <article className="target-panel" aria-label={`Deployment target ${target.clusterName}`}>
      <header>
        <div className="target-cluster-identity">
          <DeploymentTargetLogo target={target} />
          <div>
            <strong>{target.clusterName}</strong>
            <span>{target.region || 'no region'}</span>
          </div>
        </div>
        <StatusBadge status={target.status} />
      </header>

      <StateDelta syncStatus={target.syncStatus} healthStatus={target.healthStatus} />

      <dl className="target-argo-name">
        <dt>Argo application</dt>
        <dd>{target.argoApplication}</dd>
      </dl>

      {target.message && (
        <p className="target-message" role="status">
          {target.message}
        </p>
      )}

      {target.argoApplicationUrl ? (
        <div className="target-actions">
          <a href={target.argoApplicationUrl} target="_blank" rel="noreferrer">
            Open in Argo CD
          </a>
        </div>
      ) : (
        <p className="target-unavailable">
          Argo CD UI access is not configured for this cluster.
        </p>
      )}
    </article>
  )
}
