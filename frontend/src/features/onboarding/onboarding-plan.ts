import { parse } from 'yaml'

/**
 * What an onboarding will create, derived from the form alone so the operator
 * sees resource names before anything is committed. It mirrors the chart's
 * naming helpers (63-character DNS labels, suffixed resource names).
 */

export const dnsLabel = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/

type ChartValues = {
  fullnameOverride?: string
  serviceAccount?: { create?: boolean; name?: string }
  autoscaling?: { enabled?: boolean }
  ingress?: { enabled?: boolean }
}

export type PlannedResource = {
  kind: string
  name: string
  href?: string
}

function helmName(value: string) {
  return value.slice(0, 63).replace(/-+$/, '')
}

function suffixedResourceName(stem: string, suffix: string) {
  const maxStemLength = 62 - suffix.length
  return `${stem.slice(0, maxStemLength).replace(/-+$/, '')}-${suffix}`
}

export function plannedResources(
  applicationName: string,
  environment: string,
  region: string,
  valuesYaml: string,
  valuesRepositoryBaseUrl: string,
  valuesRevision: string,
): PlannedResource[] | null {
  if (!applicationName || !valuesYaml) return null

  let values: ChartValues
  try {
    values = (parse(valuesYaml) ?? {}) as ChartValues
  } catch {
    return null
  }

  const releaseName = helmName(`${applicationName}-${environment}-${region}`)
  const resourceStem = values.fullnameOverride?.trim()
    ? helmName(values.fullnameOverride.trim())
    : releaseName
  const serviceAccountName =
    values.serviceAccount?.name?.trim() || suffixedResourceName(resourceStem, 'serviceaccount')
  const items: PlannedResource[] = [
    { kind: 'Namespace', name: releaseName },
    { kind: 'Deployment', name: suffixedResourceName(resourceStem, 'deployment') },
    { kind: 'Service', name: suffixedResourceName(resourceStem, 'service') },
  ]

  if (values.serviceAccount?.create !== false) {
    items.push({
      kind: 'ServiceAccount',
      name: serviceAccountName,
    })
  }
  if (values.autoscaling?.enabled) {
    items.push({
      kind: 'HorizontalPodAutoscaler',
      name: suffixedResourceName(resourceStem, 'hpa'),
    })
  }
  if (values.ingress?.enabled) {
    items.push({ kind: 'Ingress', name: suffixedResourceName(resourceStem, 'ingress') })
  }
  items.push({ kind: 'Argo CD Application', name: releaseName })
  if (valuesRepositoryBaseUrl) {
    const repositoryUrl = `${valuesRepositoryBaseUrl.replace(/\/+$/, '')}/${applicationName}`
    items.push({
      kind: 'GitHub Repository',
      name: repositoryUrl,
      href: repositoryUrl,
    })
  }
  if (valuesRevision) {
    items.push({ kind: 'GitHub Branch', name: valuesRevision })
  }

  return items
}
