import type { ApplicationDeployment } from '../api/onboarding'
import type { Provider } from '../api/inventory'
import { KubernetesLogo, ProviderLogo } from './BrandIcons'

/**
 * A deployment target only names its cluster and source, so the provider is
 * inferred from those identifiers; anything unrecognised falls back to the
 * Kubernetes mark rather than guessing.
 */
function targetProvider(target: ApplicationDeployment): Provider | null {
  const fingerprint =
    `${target.sourceId} ${target.providerResourceId} ${target.clusterName}`.toLowerCase()
  if (fingerprint.includes('minikube')) return 'minikube'
  if (fingerprint.includes('docker')) return 'docker'
  if (fingerprint.includes('azure') || fingerprint.includes('aks')) return 'azure'
  if (
    fingerprint.includes('google') ||
    fingerprint.includes('gke') ||
    fingerprint.includes('gcp')
  ) {
    return 'gcp'
  }
  if (
    fingerprint.includes('amazon') ||
    fingerprint.includes('eks') ||
    fingerprint.includes('aws')
  ) {
    return 'aws'
  }
  return null
}

export function DeploymentTargetLogo({ target }: { target: ApplicationDeployment }) {
  const provider = targetProvider(target)
  return (
    <span className="target-logo" aria-hidden="true">
      {provider ? <ProviderLogo provider={provider} /> : <KubernetesLogo />}
    </span>
  )
}
