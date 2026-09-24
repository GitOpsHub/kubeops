import { useCallback, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { parse } from 'yaml'
import { errorMessage } from '../../api/client'
import {
  createApplicationOnboarding,
  getOnboardingClusters,
  getOnboardingDefaults,
} from '../../api/onboarding'
import { ProviderLogo } from '../../components/BrandIcons'
import { Banner } from '../../components/ui/Banner'
import { StatusBadge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageHeader } from '../../components/ui/PageHeader'
import { SkeletonRows } from '../../components/ui/Skeleton'
import { usePolledResource } from '../../hooks/usePolledResource'
import { plural } from '../../lib/format'
import { dnsLabel, plannedResources } from './onboarding-plan'
import '../../components/ui/DataTable.css'
import './onboarding.css'

const environments = ['dev', 'qa', 'prod']
const regions = ['us-east-1', 'us-east-2']
const maxValuesBytes = 256 * 1024

function validateMapping(yamlText: string, label: string) {
  if (new TextEncoder().encode(yamlText).length > maxValuesBytes) {
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

type StepProps = {
  index: number
  id: string
  title: string
  description: string
  complete: boolean
  children: ReactNode
}

function Step({ index, id, title, description, complete, children }: StepProps) {
  return (
    <section
      className={complete ? 'onboarding-step is-complete' : 'onboarding-step'}
      aria-labelledby={id}
    >
      <header className="onboarding-step-header">
        <span className="onboarding-step-index" aria-hidden="true">
          {complete ? '✓' : index}
        </span>
        <div>
          <h2 id={id}>{title}</h2>
          <p>{description}</p>
        </div>
      </header>
      <div className="onboarding-step-body">{children}</div>
    </section>
  )
}

/**
 * One form, laid out as the five steps an onboarding goes through. Every step
 * stays on the page — nothing is hidden behind a Next button — so the
 * operator can read the whole release before submitting, and the step rail
 * shows what is still missing.
 */
export function OnboardingPage() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [environment, setEnvironment] = useState('dev')
  const [region, setRegion] = useState('us-east-1')
  const [selectedClusterIds, setSelectedClusterIds] = useState<string[]>([])
  const [regionValues, setRegionValues] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const loadClusters = useCallback(async (signal: AbortSignal) => {
    const clusters = await getOnboardingClusters(signal)
    return clusters.filter((cluster) => !cluster.removedAt)
  }, [])
  const clustersQuery = usePolledResource(loadClusters)
  const loadDefaults = useCallback((signal: AbortSignal) => getOnboardingDefaults(signal), [])
  const defaultsQuery = usePolledResource(loadDefaults)

  // The base values are not editable during onboarding: the chart defaults are
  // submitted as-is, so an empty string means they have not loaded.
  const valuesYaml = defaultsQuery.data?.valuesYaml ?? ''
  const valuesRepositoryBaseUrl = defaultsQuery.data?.valuesRepositoryBaseUrl ?? ''
  const valuesRevision = defaultsQuery.data?.valuesRevision ?? ''

  const selectedSet = useMemo(() => new Set(selectedClusterIds), [selectedClusterIds])
  const namespace = name
  const deploymentScope = `${environment}-${region}`
  const scopedNameLength = 63 - deploymentScope.length - 1
  const nameValid = dnsLabel.test(name) && name.length <= scopedNameLength
  const resourcePlan = useMemo(
    () =>
      nameValid
        ? plannedResources(
            name,
            environment,
            region,
            valuesYaml,
            valuesRepositoryBaseUrl,
            valuesRevision,
          )
        : null,
    [environment, name, nameValid, region, valuesRepositoryBaseUrl, valuesRevision, valuesYaml],
  )

  const sortedClusters = useMemo(
    () =>
      [...(clustersQuery.data ?? [])].sort(
        (a, b) =>
          a.sourceName.localeCompare(b.sourceName) ||
          a.location.localeCompare(b.location) ||
          a.name.localeCompare(b.name),
      ),
    [clustersQuery.data],
  )
  const selectedClusters = sortedClusters.filter((cluster) => selectedSet.has(cluster.id))

  const activeRegions = selectedClusterIds.length > 0 ? [region] : []

  function toggleCluster(id: string) {
    setSelectedClusterIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    )
  }

  function validate() {
    if (!nameValid) {
      return `Application name must leave room for the ${deploymentScope} deployment suffix.`
    }
    if (selectedClusterIds.length === 0) return 'Select at least one target cluster.'
    if (!valuesYaml.trim())
      return 'Helm chart defaults could not be loaded. Reload the page and try again.'
    for (const item of activeRegions) {
      const override = regionValues[item]
      if (!override || !override.trim()) continue
      const overrideError = validateMapping(override, `${item} values`)
      if (overrideError) return overrideError
    }
    return ''
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const validationError = validate()
    if (validationError) {
      setError(validationError)
      return
    }
    setSubmitting(true)
    try {
      const overrides: Record<string, string> = {}
      for (const item of activeRegions) {
        const override = regionValues[item]
        if (override && override.trim()) overrides[item] = override
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
      setError(errorMessage(submitError, 'Application could not be onboarded'))
    } finally {
      setSubmitting(false)
    }
  }

  const loadError = clustersQuery.error?.message || defaultsQuery.error?.message || ''
  const bannerError = error || loadError
  const overrideCount = activeRegions.filter((item) => regionValues[item]?.trim()).length

  const steps = [
    { id: 'step-release', label: 'Release', complete: nameValid },
    { id: 'step-resources', label: 'Resources', complete: resourcePlan !== null },
    { id: 'step-targets', label: 'Targets', complete: selectedClusterIds.length > 0 },
    { id: 'step-values', label: 'Values', complete: Boolean(valuesYaml) },
    { id: 'step-review', label: 'Review', complete: false },
  ]

  return (
    <section className="page" aria-labelledby="onboarding-heading">
      <PageHeader
        id="onboarding-heading"
        back={{ to: '/applications', label: 'Applications' }}
        title="Onboard an application"
        description="Define the release, check what it will create, and choose exactly where it runs."
      />

      {bannerError && (
        <Banner
          tone="error"
          title={error ? 'Onboarding cannot continue' : 'Onboarding data is unavailable'}
        >
          {bannerError}
        </Banner>
      )}

      <div className="onboarding-layout">
        <nav className="onboarding-rail" aria-label="Onboarding steps">
          <ol>
            {steps.map((step, index) => (
              <li key={step.id} className={step.complete ? 'is-complete' : undefined}>
                <a href={`#${step.id}`}>
                  <span className="onboarding-rail-index" aria-hidden="true">
                    {step.complete ? '✓' : index + 1}
                  </span>
                  {step.label}
                  {step.complete && <span className="sr-only"> (complete)</span>}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <form className="onboarding-form" onSubmit={(event) => void submit(event)}>
          <Step
            index={1}
            id="step-release"
            title="Release"
            description="The name becomes the namespace, the Argo CD application, and the values repository."
            complete={nameValid}
          >
            <div className="onboarding-fields">
              <div className="field onboarding-name">
                <label htmlFor="application-name">Application name</label>
                <input
                  id="application-name"
                  className="input mono"
                  type="text"
                  required
                  value={name}
                  pattern="[a-z0-9]([-a-z0-9]*[a-z0-9])?"
                  maxLength={scopedNameLength}
                  placeholder="payments-api"
                  aria-describedby="name-hint"
                  onChange={(event) => setName(event.target.value)}
                />
                <span className="field-hint" id="name-hint">
                  Lowercase letters, digits, and hyphens; up to {scopedNameLength} characters.
                </span>
              </div>
              <label className="field">
                <span>Environment</span>
                <select
                  className="select"
                  aria-label="Environment"
                  value={environment}
                  onChange={(event) => setEnvironment(event.target.value)}
                >
                  {environments.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Region</span>
                <select
                  className="select"
                  aria-label="Region"
                  value={region}
                  onChange={(event) => setRegion(event.target.value)}
                >
                  {regions.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </Step>

          <Step
            index={2}
            id="step-resources"
            title="Resources"
            description="What the chart will create for this release, named before anything is committed."
            complete={resourcePlan !== null}
          >
            {resourcePlan ? (
              <div className="onboarding-table">
                <table className="data-table" aria-label="Generated Kubernetes resources">
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
            ) : (
              <p className="onboarding-placeholder">
                {valuesYaml
                  ? 'Enter a valid application name to preview the generated resources.'
                  : 'Waiting for the chart defaults…'}
              </p>
            )}
          </Step>

          <Step
            index={3}
            id="step-targets"
            title="Targets"
            description="The clusters this release deploys to through their Argo CD."
            complete={selectedClusterIds.length > 0}
          >
            <div className="onboarding-table">
              <div className="onboarding-table-caption">
                <span>Target clusters</span>
                <span>{selectedClusterIds.length} selected</span>
              </div>
              {clustersQuery.loading ? (
                <div role="status">
                  <span className="sr-only">Loading clusters…</span>
                  <SkeletonRows rows={3} columns={5} />
                </div>
              ) : sortedClusters.length === 0 ? (
                <EmptyState
                  compact
                  title="No active clusters are available"
                  description="Clusters appear here once a cloud source has discovered them."
                />
              ) : (
                <div className="table-scroll">
                  <table className="data-table" aria-label="Target clusters">
                    <thead>
                      <tr>
                        <th scope="col" className="col-select">
                          <span className="sr-only">Select</span>
                        </th>
                        <th scope="col">Cluster</th>
                        <th scope="col">Source</th>
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
                          onClick={() => toggleCluster(cluster.id)}
                        >
                          <td className="col-select">
                            <input
                              type="checkbox"
                              className="checkbox"
                              aria-label={`Select ${cluster.name}`}
                              checked={selectedSet.has(cluster.id)}
                              onClick={(event) => event.stopPropagation()}
                              onChange={() => toggleCluster(cluster.id)}
                            />
                          </td>
                          <td>
                            <strong className="onboarding-cluster-name">{cluster.name}</strong>
                          </td>
                          <td>
                            <span className="onboarding-provider">
                              <ProviderLogo provider={cluster.provider} />
                              {cluster.sourceName}
                            </span>
                          </td>
                          <td className="mono">{cluster.location || 'Unknown'}</td>
                          <td className="mono">{cluster.kubernetesVersion || 'Unknown'}</td>
                          <td>
                            <StatusBadge status={cluster.status} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </Step>

          <Step
            index={4}
            id="step-values"
            title="Values"
            description="The chart defaults are used as-is; a region can override individual keys."
            complete={Boolean(valuesYaml)}
          >
            {activeRegions.length === 0 ? (
              <p className="onboarding-placeholder">
                Select a target cluster to add region overrides.
              </p>
            ) : (
              <div className="region-values">
                <p className="field-hint" id="values-guidance">
                  Do not include passwords, tokens, certificates, or other secret material.
                  Reference existing Kubernetes or external secrets from the chart values.
                </p>
                {activeRegions.map((item) => (
                  <details className="region-values-item" key={item}>
                    <summary>
                      <span className="mono">{item}/values.yaml</span>
                      <span className="subtle">
                        {regionValues[item]?.trim() ? 'customised' : 'base only'}
                      </span>
                    </summary>
                    <textarea
                      className="textarea"
                      value={regionValues[item] ?? ''}
                      spellCheck={false}
                      aria-label={`${item} values override`}
                      aria-describedby="values-guidance"
                      placeholder={`# Keys here override the chart defaults in ${item}\nreplicaCount: 3\n`}
                      onChange={(event) =>
                        setRegionValues((current) => ({ ...current, [item]: event.target.value }))
                      }
                    />
                  </details>
                ))}
              </div>
            )}
          </Step>

          <Step
            index={5}
            id="step-review"
            title="Review"
            description="Onboarding commits values to GitHub and creates the Argo CD application."
            complete={false}
          >
            <dl className="fact-grid onboarding-review">
              <div>
                <dt>Application</dt>
                <dd className="mono">{name || '—'}</dd>
              </div>
              <div>
                <dt>Scope</dt>
                <dd className="mono">{deploymentScope}</dd>
              </div>
              <div>
                <dt>Targets</dt>
                <dd>
                  {selectedClusters.length > 0
                    ? selectedClusters.map((cluster) => cluster.name).join(', ')
                    : 'None selected'}
                </dd>
              </div>
              <div>
                <dt>Values</dt>
                <dd>
                  Chart defaults
                  {overrideCount > 0 ? ` + ${plural(overrideCount, 'region override')}` : ''}
                </dd>
              </div>
            </dl>
            <div className="onboarding-submit">
              <Button
                variant="primary"
                type="submit"
                loading={submitting}
                disabled={clustersQuery.loading || !valuesYaml}
              >
                {submitting ? 'Onboarding…' : 'Onboard'}
              </Button>
            </div>
          </Step>
        </form>
      </div>
    </section>
  )
}
