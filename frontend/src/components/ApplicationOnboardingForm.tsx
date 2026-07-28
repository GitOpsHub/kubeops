import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { parse } from 'yaml'
import {
  createApplicationOnboarding,
  getOnboardingDefaults,
  getOnboardingClusters,
} from '../api/onboarding'
import type { Cluster, Provider } from '../api/inventory'
import { ProviderLogo } from './BrandIcons'

const dnsLabel = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/

// Regions are keyed per source because the same region name can appear under more
// than one cloud source.
const regionKey = (sourceId: string, region: string) => `${sourceId} ${region}`

type SourceRegions = {
  sourceId: string
  sourceName: string
  provider: Provider
  regions: { region: string; clusters: Cluster[] }[]
}

export function ApplicationOnboardingForm() {
  const navigate = useNavigate()
  const [clusters, setClusters] = useState<Cluster[]>([])
  const [name, setName] = useState('')
  const [namespace, setNamespace] = useState('')
  // The base values are not editable during onboarding; the chart defaults are
  // submitted as-is, so an empty string means they have not loaded yet.
  const [valuesYaml, setValuesYaml] = useState('')
  const [selectedRegions, setSelectedRegions] = useState<string[]>([])
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
      .then((defaults) => setValuesYaml(defaults.valuesYaml))
      .catch((defaultsError) => {
        if (!(defaultsError instanceof DOMException && defaultsError.name === 'AbortError')) {
          setError(defaultsError instanceof Error ? defaultsError.message : 'Helm defaults could not be loaded')
        }
      })
    return () => controller.abort()
  }, [load])

  const selectedSet = useMemo(() => new Set(selectedRegions), [selectedRegions])

  // Clusters are grouped into source → region so a single region choice fans out to
  // every cluster the source reports in that region.
  const sourceRegions = useMemo<SourceRegions[]>(() => {
    const sources = new Map<string, SourceRegions>()
    for (const cluster of clusters) {
      let source = sources.get(cluster.sourceId)
      if (!source) {
        source = {
          sourceId: cluster.sourceId,
          sourceName: cluster.sourceName,
          provider: cluster.provider,
          regions: [],
        }
        sources.set(cluster.sourceId, source)
      }
      let region = source.regions.find((item) => item.region === cluster.location)
      if (!region) {
        region = { region: cluster.location, clusters: [] }
        source.regions.push(region)
      }
      region.clusters.push(cluster)
    }
    for (const source of sources.values()) {
      source.regions.sort((a, b) => a.region.localeCompare(b.region))
    }
    return [...sources.values()].sort((a, b) => a.sourceName.localeCompare(b.sourceName))
  }, [clusters])

  const activeRegions = useMemo(() => {
    const names = new Set<string>()
    for (const source of sourceRegions) {
      for (const region of source.regions) {
        if (selectedSet.has(regionKey(source.sourceId, region.region))) names.add(region.region)
      }
    }
    return [...names].sort()
  }, [sourceRegions, selectedSet])

  const selectedClusterIds = useMemo(() => {
    const ids: string[] = []
    for (const source of sourceRegions) {
      for (const region of source.regions) {
        if (!selectedSet.has(regionKey(source.sourceId, region.region))) continue
        ids.push(...region.clusters.map((cluster) => cluster.id))
      }
    }
    return ids
  }, [sourceRegions, selectedSet])

  function toggleRegion(key: string) {
    setSelectedRegions((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
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
    if (!dnsLabel.test(name) || name.length > 63) return 'Application name must be a lowercase DNS label.'
    if (!dnsLabel.test(namespace) || namespace.length > 63) return 'Namespace must be a lowercase DNS label.'
    if (selectedClusterIds.length === 0) return 'Select at least one target region.'
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
          <Link className="text-button detail-back" to="/applications">
            ← Applications
          </Link>
          <p className="kicker">GitOps delivery</p>
          <h1 id="onboarding-heading">Onboard an application</h1>
          <p>Create the same Argo CD-managed Helm release across one or more clusters.</p>
        </div>
      </div>

      {error && <div className="error-banner" role="alert"><span>{error}</span></div>}

      <form className="onboarding-form" onSubmit={(event) => void submit(event)}>
        <div className="section-heading section-heading--compact">
          <div>
            <p className="section-label">Application definition</p>
            <h2>Minimal deployment details</h2>
          </div>
        </div>

        <div className="onboarding-fields">
          <label>
            <span>Application name</span>
            <input
              required
              value={name}
              pattern="[a-z0-9]([-a-z0-9]*[a-z0-9])?"
              maxLength={63}
              placeholder="payments-api"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            <span>Namespace</span>
            <input
              required
              value={namespace}
              pattern="[a-z0-9]([-a-z0-9]*[a-z0-9])?"
              maxLength={63}
              placeholder="payments"
              onChange={(event) => setNamespace(event.target.value)}
            />
          </label>
        </div>

        <fieldset className="cluster-picker">
          <legend>
            Target regions{' '}
            <span>
              {selectedRegions.length} selected · {selectedClusterIds.length} clusters
            </span>
          </legend>
          {loading ? (
            <div className="compact-state">Loading regions…</div>
          ) : sourceRegions.length === 0 ? (
            <div className="compact-state">No active clusters are available.</div>
          ) : (
            sourceRegions.map((source) => (
              <div className="region-source" key={source.sourceId}>
                <p className="region-source-name">
                  <span className="source-logo">
                    <ProviderLogo provider={source.provider} className="provider-logo" />
                  </span>
                  {source.sourceName}
                </p>
                {source.regions.map((region) => {
                  const key = regionKey(source.sourceId, region.region)
                  return (
                    <label className="cluster-option" key={key}>
                      <input
                        type="checkbox"
                        checked={selectedSet.has(key)}
                        onChange={() => toggleRegion(key)}
                      />
                      <span>
                        <strong>{region.region}</strong>
                        <small>
                          {region.clusters.length}{' '}
                          {region.clusters.length === 1 ? 'cluster' : 'clusters'} ·{' '}
                          {region.clusters.map((cluster) => cluster.name).join(', ')}
                        </small>
                      </span>
                    </label>
                  )
                })}
              </div>
            ))
          )}
        </fieldset>

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
          {submitting ? 'Creating Argo applications…' : 'Onboard application'}
        </button>
      </form>
    </section>
  )
}
