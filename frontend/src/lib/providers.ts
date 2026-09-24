import type { Provider } from '../api/inventory'

/** Display order, and the managed-Kubernetes name each provider is known by. */
export const providers: Provider[] = ['aws', 'azure', 'gcp', 'docker', 'minikube']

export const providerLabels: Record<Provider, string> = {
  aws: 'EKS',
  azure: 'AKS',
  gcp: 'GKE',
  docker: 'Docker',
  minikube: 'Minikube',
}

export const providerNames: Record<Provider, string> = {
  aws: 'Amazon Web Services',
  azure: 'Microsoft Azure',
  gcp: 'Google Cloud',
  docker: 'Docker Desktop',
  minikube: 'Minikube',
}

export function emptyProviderCounts(): Record<Provider, number> {
  return { aws: 0, azure: 0, gcp: 0, docker: 0, minikube: 0 }
}

/** Inventory older than this (two missed 5-minute syncs) is no longer trusted. */
export const staleAfterMs = 11 * 60 * 1000
