import { useCallback, useEffect, useRef, useState } from 'react'
import {
  type Cluster,
  type ClusterDetails,
  type ArgoAccess,
  type NodePool,
  getClusterArgoAccess,
  getClusterDetails,
  scaleNodePool,
} from '../api/inventory'
import { KubernetesLogo } from './BrandIcons'

const providerLabels = {
  aws: 'EKS',
  azure: 'AKS',
  gcp: 'GKE',
  docker: 'Docker',
  minikube: 'Minikube',
}

type PendingScale = {
  pool: NodePool
  desiredCount: number
}

type NetworkFact = {
  label: string
  value: string | string[] | boolean | undefined
}

function displayed(value: NetworkFact['value']) {
  if (typeof value === 'boolean') return value ? 'Enabled' : 'Disabled'
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'Not reported'
  return value || 'Not reported'
}

function networkFacts(details: ClusterDetails): NetworkFact[] {
  const common: NetworkFact[] = [
    { label: 'API endpoint', value: details.networking.endpointAccess },
  ]
  if (details.networking.aws) {
    const network = details.networking.aws
    return common.concat([
      { label: 'VPC', value: network.vpcId },
      { label: 'Subnets', value: network.subnetIds },
      { label: 'Cluster security group', value: network.clusterSecurityGroupId },
      { label: 'Additional security groups', value: network.additionalSecurityGroupIds },
      { label: 'Public access CIDRs', value: network.publicAccessCidrs },
      { label: 'IP family', value: network.ipFamily },
      { label: 'Service IPv4 CIDR', value: network.serviceIpv4Cidr },
      { label: 'Service IPv6 CIDR', value: network.serviceIpv6Cidr },
    ])
  }
  if (details.networking.gcp) {
    const network = details.networking.gcp
    return common.concat([
      { label: 'Network', value: network.network },
      { label: 'Subnetwork', value: network.subnetwork },
      { label: 'Pod CIDRs', value: network.podCidrs },
      { label: 'Service CIDRs', value: network.serviceCidrs },
      { label: 'Control plane CIDR', value: network.controlPlaneIpv4Cidr },
      { label: 'Private nodes', value: network.privateNodes },
      { label: 'Private endpoint', value: network.privateEndpoint },
      { label: 'Datapath', value: network.datapathProvider },
      { label: 'Network policy', value: network.networkPolicyEnabled },
    ])
  }
  if (details.networking.azure) {
    const network = details.networking.azure
    return common.concat([
      { label: 'Node subnets', value: network.subnetIds },
      { label: 'Pod subnets', value: network.podSubnetIds },
      { label: 'Network plugin', value: network.networkPlugin },
      { label: 'Network mode', value: network.networkMode },
      { label: 'Network policy', value: network.networkPolicy },
      { label: 'Network dataplane', value: network.networkDataplane },
      { label: 'Pod CIDRs', value: network.podCidrs },
      { label: 'Service CIDRs', value: network.serviceCidrs },
      { label: 'DNS service IP', value: network.dnsServiceIp },
      { label: 'Outbound type', value: network.outboundType },
      { label: 'Load balancer SKU', value: network.loadBalancerSku },
      { label: 'Private DNS zone', value: network.privateDnsZone },
    ])
  }
  return common.concat([{ label: 'API server', value: details.networking.local?.apiServer }])
}

function settled(status: string) {
  return ['active', 'running', 'succeeded'].includes(status.toLowerCase())
}

export function ClusterDetailDrawer({
  cluster,
  onClose,
}: {
  cluster: Cluster
  onClose: () => void
}) {
  const [details, setDetails] = useState<ClusterDetails | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailError, setDetailError] = useState('')
  const [argoAccess, setArgoAccess] = useState<ArgoAccess | null>(null)
  const [argoError, setArgoError] = useState('')
  const [desiredCounts, setDesiredCounts] = useState<Record<string, string>>({})
  const [pending, setPending] = useState<PendingScale | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [scaleMessage, setScaleMessage] = useState('')
  const [pollTarget, setPollTarget] = useState<PendingScale | null>(null)
  const pollStartedAt = useRef(0)
  const closeButton = useRef<HTMLButtonElement>(null)

  const loadDetails = useCallback(
    async (signal?: AbortSignal, quiet = false) => {
      if (!quiet) setLoading(true)
      try {
        const next = await getClusterDetails(cluster.id, signal)
        setDetails(next)
        setDesiredCounts((current) => {
          const values = { ...current }
          for (const pool of next.nodePools) {
            if (values[pool.id] === undefined) values[pool.id] = String(pool.desiredCount)
          }
          return values
        })
        setDetailError('')
        return next
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setDetailError(error instanceof Error ? error.message : 'Live details could not be loaded')
        }
        return null
      } finally {
        if (!quiet) setLoading(false)
      }
    },
    [cluster.id],
  )

  useEffect(() => {
    const controller = new AbortController()
    void loadDetails(controller.signal)
    void getClusterArgoAccess(cluster.id, controller.signal)
      .then((access) => {
        setArgoAccess(access)
        setArgoError('')
      })
      .catch((error) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setArgoError(error instanceof Error ? error.message : 'Argo CD access is unavailable')
        }
      })
    closeButton.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      controller.abort()
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [cluster.id, loadDetails, onClose])

  useEffect(() => {
    if (!pollTarget) return
    const poll = async () => {
      if (Date.now() - pollStartedAt.current >= 120_000) {
        setScaleMessage('Scaling is still continuing in the cloud provider.')
        setPollTarget(null)
        return
      }
      const next = await loadDetails(undefined, true)
      const pool = next?.nodePools.find((item) => item.id === pollTarget.pool.id)
      if (pool && pool.desiredCount === pollTarget.desiredCount && settled(pool.status)) {
        setScaleMessage(`${pool.name} is now configured for ${pool.desiredCount} nodes.`)
        setPollTarget(null)
      }
    }
    const interval = window.setInterval(() => void poll(), 5_000)
    return () => window.clearInterval(interval)
  }, [loadDetails, pollTarget])

  async function confirmScale() {
    if (!pending) return
    setSubmitting(true)
    setScaleMessage('')
    try {
      const result = await scaleNodePool(cluster.id, pending.pool.id, pending.desiredCount)
      if (result.status === 'unchanged') {
        setScaleMessage(`${pending.pool.name} is already configured for ${pending.desiredCount} nodes.`)
      } else {
        setScaleMessage(`Scaling ${pending.pool.name} to ${pending.desiredCount} nodes…`)
        pollStartedAt.current = Date.now()
        setPollTarget(pending)
      }
      setPending(null)
      await loadDetails(undefined, true)
    } catch (error) {
      setScaleMessage(error instanceof Error ? error.message : 'The scaling request failed')
    } finally {
      setSubmitting(false)
    }
  }

  function reviewScale(pool: NodePool) {
    const value = Number(desiredCounts[pool.id])
    if (!Number.isInteger(value) || value < 0) {
      setScaleMessage('Enter a nonnegative whole number of nodes.')
      return
    }
    setScaleMessage('')
    setPending({ pool, desiredCount: value })
  }

  return (
    <div className="drawer-backdrop" role="presentation" onMouseDown={onClose}>
      <aside
        className="detail-drawer detail-drawer--operations"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cluster-detail-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          ref={closeButton}
          className="drawer-close"
          type="button"
          onClick={onClose}
          aria-label="Close cluster details"
        >
          ×
        </button>

        <header className="drawer-identity">
          <KubernetesLogo className="drawer-kubernetes-logo" />
          <div>
            <p className="section-label">{providerLabels[cluster.provider]}</p>
            <h2 id="cluster-detail-title">{cluster.name}</h2>
          </div>
        </header>
        <p className="drawer-source">{cluster.sourceName} · {cluster.location}</p>

        <section className="operations-section" aria-labelledby="overview-heading">
          <div className="operations-heading">
            <div>
              <p className="section-label">Overview</p>
              <h3 id="overview-heading">Cluster state</h3>
            </div>
          </div>
          <dl className="overview-grid">
            <div><dt>Status</dt><dd>{cluster.removedAt ? 'removed' : cluster.status}</dd></div>
            <div><dt>Kubernetes</dt><dd>{cluster.kubernetesVersion || 'Unknown'}</dd></div>
            <div><dt>Endpoint</dt><dd>{cluster.endpointAccess}</dd></div>
            <div><dt>Nodes</dt><dd>{cluster.nodeCount ?? 'Not reported'}</dd></div>
            <div><dt>First seen</dt><dd>{new Date(cluster.firstSeenAt).toLocaleString()}</dd></div>
            <div><dt>Last seen</dt><dd>{new Date(cluster.lastSeenAt).toLocaleString()}</dd></div>
          </dl>
        </section>

        <section className="operations-section" aria-labelledby="node-pools-heading">
          <div className="operations-heading">
            <div>
              <p className="section-label">Compute</p>
              <h3 id="node-pools-heading">Node pools</h3>
            </div>
            {pollTarget && <span className="operation-state"><i /> Scaling</span>}
          </div>
          {loading ? (
            <div className="drawer-state" role="status"><span className="loader" /> Loading live capacity…</div>
          ) : detailError ? (
            <div className="drawer-state drawer-state--error" role="alert">
              <span>{detailError}</span>
              <button type="button" onClick={() => void loadDetails()}>Retry</button>
            </div>
          ) : details?.nodePools.length ? (
            <div className="node-pool-list">
              {details.nodePools.map((pool) => {
                const desired = Number(desiredCounts[pool.id])
                const changed = Number.isInteger(desired) && desired !== pool.desiredCount
                return (
                  <article className="node-pool-card" key={pool.id}>
                    <div className="capacity-rail" aria-hidden="true">
                      <span style={{ width: `${Math.min(100, Math.max(8, pool.desiredCount * 8))}%` }} />
                    </div>
                    <div className="node-pool-title">
                      <div>
                        <strong>{pool.name}</strong>
                        <span>{pool.machineType || 'Machine type not reported'}</span>
                      </div>
                      <span className={`pool-status pool-status--${pool.status}`}>{pool.status}</span>
                    </div>
                    <div className="pool-facts">
                      <span>Configured <strong>{pool.desiredCount}</strong></span>
                      <span>Bounds <strong>{pool.minCount ?? 0}–{pool.maxCount ?? 'provider limit'}</strong></span>
                      <span>Autoscaling <strong>{pool.autoscaling}</strong></span>
                    </div>
                    {pool.zones.length > 0 && <p className="pool-zones">{pool.zones.join(' · ')}</p>}
                    <div className="scale-control">
                      <label>
                        <span>Desired nodes</span>
                        <input
                          type="number"
                          min={pool.minCount ?? 0}
                          max={pool.maxCount ?? undefined}
                          step="1"
                          value={desiredCounts[pool.id] ?? pool.desiredCount}
                          disabled={!pool.scalable || submitting || pollTarget?.pool.id === pool.id}
                          onChange={(event) => setDesiredCounts((current) => ({
                            ...current,
                            [pool.id]: event.target.value,
                          }))}
                        />
                      </label>
                      <button
                        type="button"
                        disabled={!pool.scalable || !changed || submitting || pollTarget?.pool.id === pool.id}
                        onClick={() => reviewScale(pool)}
                      >
                        Review scale
                      </button>
                    </div>
                    {!pool.scalable && <p className="pool-note">{pool.unavailableReason}</p>}
                    {pool.autoscaling !== 'disabled' && (
                      <p className="pool-note">Autoscaling may change this desired size later.</p>
                    )}
                  </article>
                )
              })}
            </div>
          ) : (
            <div className="drawer-state">
              {details?.capability.reason || 'No provider-managed node pools were found.'}
            </div>
          )}
          {scaleMessage && <p className="scale-message" role="status">{scaleMessage}</p>}
        </section>

        <section className="operations-section" aria-labelledby="networking-heading">
          <div className="operations-heading">
            <div>
              <p className="section-label">Connectivity</p>
              <h3 id="networking-heading">Networking</h3>
            </div>
            <span className="read-only-badge">Read only</span>
          </div>
          {details ? (
            <dl className="network-grid">
              {networkFacts(details).map((fact) => (
                <div key={fact.label}>
                  <dt>{fact.label}</dt>
                  <dd>{displayed(fact.value)}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <div className="drawer-state">Networking details are unavailable.</div>
          )}
        </section>

        <section className="operations-section" aria-labelledby="argo-heading">
          <div className="operations-heading">
            <div>
              <p className="section-label">GitOps</p>
              <h3 id="argo-heading">Argo CD</h3>
            </div>
          </div>
          {argoAccess ? (
            <div className="argo-access">
              <p>Open this cluster in Argo CD through KubeOps.</p>
              <div className="argo-access-actions">
                <a href={argoAccess.url} target="_blank" rel="noreferrer">
                  Open in Argo CD
                </a>
              </div>
            </div>
          ) : (
            <div className="drawer-state">{argoError || 'Loading Argo CD access…'}</div>
          )}
        </section>

        <div className="resource-id">
          <span>Provider resource ID</span>
          <code>{cluster.providerResourceId}</code>
        </div>

        {pending && (
          <div className="confirmation-backdrop" role="presentation">
            <section
              className="scale-confirmation"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="scale-confirmation-title"
            >
              <p className="section-label">Review change</p>
              <h3 id="scale-confirmation-title">Scale {pending.pool.name}?</h3>
              <div className="scale-delta">
                <span>{pending.pool.desiredCount}</span>
                <i aria-hidden="true">→</i>
                <strong>{pending.desiredCount}</strong>
              </div>
              <p>
                This changes the configured capacity for <strong>{cluster.name}</strong> by{' '}
                {pending.desiredCount - pending.pool.desiredCount} nodes.
              </p>
              {pending.desiredCount < pending.pool.desiredCount && (
                <p className="confirmation-warning">Scaling down can evict workloads from removed nodes.</p>
              )}
              {pending.pool.autoscaling !== 'disabled' && (
                <p className="confirmation-warning">
                  Autoscaling is {pending.pool.autoscaling} and may override this size.
                </p>
              )}
              <div className="confirmation-actions">
                <button type="button" onClick={() => setPending(null)} disabled={submitting}>Cancel</button>
                <button className="confirm-scale" type="button" onClick={() => void confirmScale()} disabled={submitting}>
                  {submitting ? 'Requesting…' : 'Confirm scale'}
                </button>
              </div>
            </section>
          </div>
        )}
      </aside>
    </div>
  )
}
