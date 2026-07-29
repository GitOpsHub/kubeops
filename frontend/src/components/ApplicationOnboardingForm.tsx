import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { parse } from 'yaml'
import {
  createApplicationOnboarding,
  getOnboardingDefaults,
  getOnboardingClusters,
} from '../api/onboarding'
import type { Cluster } from '../api/inventory'
import { ProviderLogo } from './BrandIcons'
import { StatusBadge } from './StatusBadge'

const dnsLabel = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/

type ChartValues = {
  fullnameOverride?: string
  serviceAccount?: { create?: boolean; name?: string }
  autoscaling?: { enabled?: boolean }
  ingress?: { enabled?: boolean }
}

type PlannedResource = {
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

function plannedResources(
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
    values.serviceAccount?.name?.trim() ||
    suffixedResourceName(resourceStem, 'serviceaccount')
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

export function ApplicationOnboardingForm() {
  const navigate = useNavigate()
  const [clusters, setClusters] = useState<Cluster[]>([])
  const [name, setName] = useState('')
  const [environment, setEnvironment] = useState('dev')
  const [region, setRegion] = useState('us-east-1')
  // The base values are not editable during onboarding; the chart defaults are
  // submitted as-is, so an empty string means they have not loaded yet.
  const [valuesYaml, setValuesYaml] = useState('')
  const [valuesRepositoryBaseUrl, setValuesRepositoryBaseUrl] = useState('')
  const [valuesRevision, setValuesRevision] = useState('')
  const [selectedClusterIds, setSelectedClusterIds] = useState<string[]>([])
  const [regionValues, setRegionValues] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    try {
      const nextClusters = await getOnboardingClusters(signal)
      setClusters(nextClusters.filter((cluster) => !cluster.removedAt))
      setError('')
    } catch (loadError) {
      if (!(loadError instanceof DOMException && loadError.name === 'AbortError')) {
        setError(loadError instanceof Error ? loadError.message : 'Onboarding data could not be loaded')
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    void getOnboardingDefaults(controller.signal)
      .then((defaults) => {
        setValuesYaml(defaults.valuesYaml)
        setValuesRepositoryBaseUrl(defaults.valuesRepositoryBaseUrl)
        setValuesRevision(defaults.valuesRevision)
      })
      .catch((defaultsError) => {
        if (!(defaultsError instanceof DOMException && defaultsError.name === 'AbortError')) {
          setError(defaultsError instanceof Error ? defaultsError.message : 'Helm defaults could not be loaded')
        }
      })
    return () => controller.abort()
  }, [load])

  const selectedSet = useMemo(() => new Set(selectedClusterIds), [selectedClusterIds])
  const namespace = name
  const deploymentScope = `${environment}-${region}`
  const scopedNameLength = 63 - deploymentScope.length - 1
  const resourcePlan = useMemo(
    () =>
      dnsLabel.test(name) && name.length <= scopedNameLength
        ? plannedResources(
            name,
            environment,
            region,
            valuesYaml,
            valuesRepositoryBaseUrl,
            valuesRevision,
          )
        : null,
    [
      environment,
      name,
      region,
      scopedNameLength,
      valuesRepositoryBaseUrl,
      valuesRevision,
      valuesYaml,
    ],
  )

  const sortedClusters = useMemo(
    () =>
      [...clusters].sort(
        (a, b) =>
          a.sourceName.localeCompare(b.sourceName) ||
          a.location.localeCompare(b.location) ||
          a.name.localeCompare(b.name),
      ),
    [clusters],
  )

  const activeRegions = selectedClusterIds.length > 0 ? [region] : []

  function toggleCluster(id: string) {
    setSelectedClusterIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    )
  }

  function validateMapping(yamlText: string, label: string) {
    if (new TextEncoder().encode(yamlText).length > 256 * 1024) {
      return `${label} must not exceed 256 KiB.`
    }
    try {
      const values = parse(yamlText)
      if (values === null || typeof values !== 'object' || Array.isArray(values)) {
        return `${label} must contain a top-level YAML mapping.`
      }
    } catch {
      return `${label} contains invalid YAML.`
    }
    return ''
  }

  function validate() {
    if (!dnsLabel.test(name) || name.length > scopedNameLength) {
      return `Application name must leave room for the ${deploymentScope} deployment suffix.`
    }
    if (selectedClusterIds.length === 0) return 'Select at least one target cluster.'
    if (!valuesYaml.trim()) {
      return 'Helm chart defaults could not be loaded. Reload the page and try again.'
    }
    for (const region of activeRegions) {
      const override = regionValues[region]
      if (!override || !override.trim()) continue
      const overrideError = validateMapping(override, `${region} values`)
      if (overrideError) return overrideError
    }
    return ''
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const validationError = validate()
    if (validationError) {
      setError(validationError)
      return
    }
    setSubmitting(true)
    try {
      const overrides: Record<string, string> = {}
      for (const region of activeRegions) {
        const override = regionValues[region]
        if (override && override.trim()) overrides[region] = override
      }
      const record = await createApplicationOnboarding({
        name,
        namespace,
        environment,
        region,
        clusterIds: selectedClusterIds,
        valuesYaml,
        regionValues: overrides,
      })
      setError('')
      // Deployment may still be progressing; the detail route polls until it settles.
      void navigate(`/applications/${record.id}`)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Application could not be onboarded')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="onboarding-workspace" aria-labelledby="onboarding-heading">
      <div className="onboarding-heading">
        <div>
          <Link className="onboarding-back" to="/applications">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M10.5 3.5 6 8l4.5 4.5M6.5 8H14" />
            </svg>
            <span>Back to applications</span>
          </Link>
          <h1 id="onboarding-heading">Onboard an application</h1>
          <p>Define the release context, then choose exactly where it should run.</p>
        </div>
      </div>

      {error && <div className="error-banner" role="alert"><span>{error}</span></div>}

      <form className="onboarding-form" onSubmit={(event) => void submit(event)}>
        <div className="section-heading section-heading--compact">
          <div>
            <p className="section-label">Application definition</p>
            <h2>Release context</h2>
          </div>
        </div>

        <div className="onboarding-fields">
          <label>
            <span>Application name</span>
            <input
              type="text"
              required
              value={name}
              pattern="[a-z0-9]([-a-z0-9]*[a-z0-9])?"
              maxLength={scopedNameLength}
              placeholder="payments-api"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            <span>Environment</span>
            <select
              aria-label="Environment"
              value={environment}
              onChange={(event) => setEnvironment(event.target.value)}
            >
              <option value="dev">dev</option>
              <option value="qa">qa</option>
              <option value="prod">prod</option>
            </select>
          </label>
          <label>
            <span>Region</span>
            <select
              aria-label="Region"
              value={region}
              onChange={(event) => setRegion(event.target.value)}
            >
              <option value="us-east-1">us-east-1</option>
              <option value="us-east-2">us-east-2</option>
            </select>
          </label>
        </div>

        {resourcePlan && (
          <div className="resource-preview">
            <table
              className="resource-preview-table"
              aria-label="Generated Kubernetes resources"
            >
              <thead>
                <tr>
                  <th scope="col">Resource</th>
                  <th scope="col">Name</th>
                </tr>
              </thead>
              <tbody>
                {resourcePlan.map((resource) => (
                  <tr key={`${resource.kind}-${resource.name}`}>
                    <td>{resource.kind}</td>
                    <td className="mono">
                      {resource.href ? (
                        <a href={resource.href} target="_blank" rel="noreferrer">
                          {resource.name}
                        </a>
                      ) : (
                        resource.name
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <section className="target-cluster-picker" aria-labelledby="target-clusters-heading">
          <header className="target-cluster-heading">
            <h3 id="target-clusters-heading">Target clusters</h3>
            <span>{selectedClusterIds.length} selected</span>
          </header>
          {loading ? (
            <div className="compact-state">Loading clusters…</div>
          ) : sortedClusters.length === 0 ? (
            <div className="compact-state">No active clusters are available.</div>
          ) : (
            <div className="target-cluster-table-wrap">
              <table className="target-cluster-table">
                <thead>
                  <tr>
                    <th scope="col" className="target-select-column">Select</th>
                    <th scope="col">Cluster</th>
                    <th scope="col">Provider</th>
                    <th scope="col">Location</th>
                    <th scope="col">Kubernetes</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedClusters.map((cluster) => (
                    <tr
                      className={selectedSet.has(cluster.id) ? 'is-selected' : undefined}
                      key={cluster.id}
                    >
                      <td className="target-select-column">
                        <input
                          type="checkbox"
                          aria-label={`Select ${cluster.name}`}
                          checked={selectedSet.has(cluster.id)}
                          onChange={() => toggleCluster(cluster.id)}
                        />
                      </td>
                      <td>
                        <strong className="target-cluster-name">{cluster.name}</strong>
                      </td>
                      <td>
                        <span className="target-provider">
                          <ProviderLogo provider={cluster.provider} className="provider-logo" />
                          <span>{cluster.sourceName}</span>
                        </span>
                      </td>
                      <td className="mono">{cluster.location || 'Unknown'}</td>
                      <td className="mono">{cluster.kubernetesVersion || 'Unknown'}</td>
                      <td><StatusBadge status={cluster.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {activeRegions.length > 0 && (
          <div className="region-values">
            <p className="section-label">Region overrides</p>
            <p className="values-guidance" id="values-guidance">
              Do not include passwords, tokens, certificates, or other secret material.
              Reference existing Kubernetes or external secrets from the chart values.
            </p>
            {activeRegions.map((region) => (
              <details className="region-values-item" key={region}>
                <summary>
                  {region}/values.yaml
                  <span>{regionValues[region]?.trim() ? 'customised' : 'base only'}</span>
                </summary>
                <textarea
                  value={regionValues[region] ?? ''}
                  spellCheck={false}
                  aria-describedby="values-guidance"
                  placeholder={`# Keys here override the chart defaults in ${region}\nreplicaCount: 3\n`}
                  onChange={(event) =>
                    setRegionValues((current) => ({ ...current, [region]: event.target.value }))
                  }
                />
              </details>
            ))}
          </div>
        )}

        <button
          className="primary-button"
          type="submit"
          disabled={submitting || loading || !valuesYaml}
        >
          {submitting ? 'Onboarding…' : 'Onboard'}
        </button>
      </form>
    </section>
  )
}
