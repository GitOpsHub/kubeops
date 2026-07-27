import { useCallback, useEffect, useMemo, useState } from 'react'
import { parse } from 'yaml'
import {
  createApplicationOnboarding,
  getApplicationOnboardings,
  getOnboardingClusters,
  type ApplicationOnboarding as OnboardingRecord,
} from '../api/onboarding'
import type { Cluster } from '../api/inventory'
import { KubernetesLogo, ProviderLogo } from './BrandIcons'

const dnsLabel = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/

type Props = {
  onBack: () => void
}

export function ApplicationOnboarding({ onBack }: Props) {
  const [clusters, setClusters] = useState<Cluster[]>([])
  const [records, setRecords] = useState<OnboardingRecord[]>([])
  const [name, setName] = useState('')
  const [namespace, setNamespace] = useState('')
  const [valuesYaml, setValuesYaml] = useState('replicaCount: 1\n')
  const [selected, setSelected] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async (signal?: AbortSignal, quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      const [nextClusters, nextRecords] = await Promise.all([
        getOnboardingClusters(signal),
        getApplicationOnboardings(signal),
      ])
      setClusters(nextClusters.filter((cluster) => !cluster.removedAt))
      setRecords(nextRecords)
      setError('')
    } catch (loadError) {
      if (!(loadError instanceof DOMException && loadError.name === 'AbortError')) {
        setError(loadError instanceof Error ? loadError.message : 'Onboarding data could not be loaded')
      }
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    const interval = window.setInterval(() => void load(undefined, true), 5_000)
    return () => {
      controller.abort()
      window.clearInterval(interval)
    }
  }, [load])

  const selectedSet = useMemo(() => new Set(selected), [selected])

  function toggleCluster(clusterId: string) {
    setSelected((current) =>
      current.includes(clusterId)
        ? current.filter((item) => item !== clusterId)
        : [...current, clusterId],
    )
  }

  function validate() {
    if (!dnsLabel.test(name) || name.length > 63) return 'Application name must be a lowercase DNS label.'
    if (!dnsLabel.test(namespace) || namespace.length > 63) return 'Namespace must be a lowercase DNS label.'
    if (selected.length === 0) return 'Select at least one target cluster.'
    if (new TextEncoder().encode(valuesYaml).length > 256 * 1024) {
      return 'Helm values must not exceed 256 KiB.'
    }
    try {
      const values = parse(valuesYaml)
      if (values === null || typeof values !== 'object' || Array.isArray(values)) {
        return 'Helm values must contain a top-level YAML mapping.'
      }
    } catch {
      return 'Helm values contain invalid YAML.'
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
      const record = await createApplicationOnboarding({
        name,
        namespace,
        clusterIds: selected,
        valuesYaml,
      })
      setRecords((current) => [record, ...current.filter((item) => item.id !== record.id)])
      setName('')
      setNamespace('')
      setSelected([])
      setValuesYaml('replicaCount: 1\n')
      setError('')
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
          <button type="button" className="text-button onboarding-back" onClick={onBack}>
            ← Fleet inventory
          </button>
          <p className="kicker">GitOps delivery</p>
          <h1 id="onboarding-heading">Onboard an application</h1>
          <p>Create the same Argo CD-managed Helm release across one or more clusters.</p>
        </div>
        <KubernetesLogo className="onboarding-mark" />
      </div>

      {error && <div className="error-banner" role="alert"><span>{error}</span></div>}

      <div className="onboarding-grid">
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
            <legend>Target clusters <span>{selected.length} selected</span></legend>
            {loading ? (
              <div className="compact-state">Loading clusters…</div>
            ) : clusters.length === 0 ? (
              <div className="compact-state">No active clusters are available.</div>
            ) : (
              clusters.map((cluster) => (
                <label className="cluster-option" key={cluster.id}>
                  <input
                    type="checkbox"
                    checked={selectedSet.has(cluster.id)}
                    onChange={() => toggleCluster(cluster.id)}
                  />
                  <span className="source-logo">
                    <ProviderLogo provider={cluster.provider} className="provider-logo" />
                  </span>
                  <span>
                    <strong>{cluster.name}</strong>
                    <small>{cluster.sourceName} · {cluster.location}</small>
                  </span>
                </label>
              ))
            )}
          </fieldset>

          <label className="values-field">
            <span>Helm values YAML</span>
            <textarea
              value={valuesYaml}
              spellCheck={false}
              onChange={(event) => setValuesYaml(event.target.value)}
              aria-describedby="values-guidance"
            />
          </label>
          <p className="values-guidance" id="values-guidance">
            Do not include passwords, tokens, certificates, or other secret material. Reference
            existing Kubernetes or external secrets from the chart values.
          </p>

          <button className="primary-button" type="submit" disabled={submitting || loading}>
            {submitting ? 'Creating Argo applications…' : 'Onboard application'}
          </button>
        </form>

        <div className="onboarding-history">
          <div className="section-heading section-heading--compact">
            <div>
              <p className="section-label">Deployment status</p>
              <h2>Recent onboardings</h2>
            </div>
            <span className="quiet-note">Refreshes every 5 seconds</span>
          </div>
          {records.length === 0 ? (
            <div className="empty-panel">Submitted applications will appear here.</div>
          ) : (
            records.map((record) => (
              <article className="onboarding-record" key={record.id}>
                <header>
                  <div>
                    <strong>{record.name}</strong>
                    <span>{record.namespace} · {record.chartName}@{record.chartRevision}</span>
                  </div>
                  <span className={`deployment-pill deployment-pill--${record.status}`}>
                    {record.status}
                  </span>
                </header>
                <div className="deployment-targets">
                  {record.targets.map((target) => (
                    <div className="deployment-target" key={target.id}>
                      <span className={`sync-dot sync-dot--${target.status}`} />
                      <div>
                        <strong>{target.clusterName}</strong>
                        <span>{target.syncStatus} · {target.healthStatus}</span>
                        {target.message && <small>{target.message}</small>}
                      </div>
                      <span className={`deployment-pill deployment-pill--${target.status}`}>
                        {target.status}
                      </span>
                    </div>
                  ))}
                </div>
              </article>
            ))
          )}
        </div>
      </div>
    </section>
  )
}
