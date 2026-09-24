import { useCallback, useEffect, useRef, useState } from 'react'
import {
  type Cluster,
  type ClusterDetails,
  type ArgoAccess,
  type NodePool,
  getClusterArgoAccess,
  getClusterDetails,
  scaleNodePool,
} from '../../api/inventory'
import { errorMessage, isAbortError } from '../../api/client'
import { KubernetesLogo } from '../../components/BrandIcons'
import { Banner } from '../../components/ui/Banner'
import { StatusBadge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { buttonClass } from '../../components/ui/button-class'
import { Dialog, DialogClose, DialogDescription, DialogTitle } from '../../components/ui/Dialog'
import { Skeleton } from '../../components/ui/Skeleton'
import { providerLabels } from '../../lib/providers'
import './cluster-drawer.css'

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

function isReported(value: NetworkFact['value']) {
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'string') return value.trim().length > 0
  return value !== undefined
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
        if (!isAbortError(error))
          setDetailError(errorMessage(error, 'Live details could not be loaded'))
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
        if (!isAbortError(error)) setArgoError(errorMessage(error, 'Argo CD access is unavailable'))
      })
    return () => controller.abort()
  }, [cluster.id, loadDetails])

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
        setScaleMessage(
          `${pending.pool.name} is already configured for ${pending.desiredCount} nodes.`,
        )
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

  const connectivityFacts = details ? networkFacts(details) : []
  const reportedConnectivityFacts = connectivityFacts.filter((fact) => isReported(fact.value))
  const unreportedConnectivityCount = connectivityFacts.length - reportedConnectivityFacts.length

  return (
    <>
      <Dialog
        open
        onOpenChange={(next) => !next && onClose()}
        variant="sheet"
        className="cluster-detail-modal"
        describedBy={undefined}
      >
        <header className="dialog-header cluster-sheet-header">
          <KubernetesLogo className="cluster-sheet-logo" />
          <div className="dialog-title-group">
            <p className="kicker">{providerLabels[cluster.provider]}</p>
            <DialogTitle asChild>
              <h2>{cluster.name}</h2>
            </DialogTitle>
            <p className="subtle">
              {cluster.sourceName} · {cluster.location}
            </p>
          </div>
          <DialogClose asChild>
            <Button
              variant="ghost"
              iconOnly
              className="dialog-close"
              aria-label="Close cluster details"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="m4 4 8 8M12 4l-8 8" />
              </svg>
            </Button>
          </DialogClose>
        </header>

        <div className="dialog-body cluster-sheet-body">
          <section className="sheet-section" aria-labelledby="cluster-state-heading">
            <h3 id="cluster-state-heading">Cluster state</h3>
            <dl className="fact-grid">
              <div>
                <dt>Status</dt>
                <dd>
                  <StatusBadge
                    status={cluster.removedAt ? 'removed' : cluster.status}
                    tone={cluster.removedAt ? 'idle' : undefined}
                  />
                </dd>
              </div>
              <div>
                <dt>Kubernetes</dt>
                <dd className="mono">{cluster.kubernetesVersion || 'Unknown'}</dd>
              </div>
              <div>
                <dt>Endpoint</dt>
                <dd>{cluster.endpointAccess}</dd>
              </div>
              <div>
                <dt>Nodes</dt>
                <dd>{cluster.nodeCount ?? 'Not reported'}</dd>
              </div>
              <div>
                <dt>First seen</dt>
                <dd>{new Date(cluster.firstSeenAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt>Last seen</dt>
                <dd>{new Date(cluster.lastSeenAt).toLocaleString()}</dd>
              </div>
            </dl>
          </section>

          <section className="sheet-section" aria-labelledby="node-pools-heading">
            <div className="sheet-section-heading">
              <h3 id="node-pools-heading">Node pools</h3>
              {pollTarget && <StatusBadge status="updating" />}
            </div>
            {loading ? (
              <div role="status" className="sheet-loading">
                <span className="sr-only">Loading live capacity…</span>
                <Skeleton height={120} radius="var(--radius-md)" />
              </div>
            ) : detailError ? (
              <Banner
                tone="error"
                title="Live details could not be loaded"
                onRetry={() => void loadDetails()}
                retryLabel="Retry"
              >
                {detailError}
              </Banner>
            ) : details?.nodePools.length ? (
              <div className="node-pool-list">
                {details.nodePools.map((pool) => {
                  const desired = Number(desiredCounts[pool.id])
                  const changed = Number.isInteger(desired) && desired !== pool.desiredCount
                  const busy = submitting || pollTarget?.pool.id === pool.id
                  return (
                    <article className="node-pool" key={pool.id}>
                      <div className="node-pool-title">
                        <div className="cell-stack">
                          <strong>{pool.name}</strong>
                          <small className="mono">
                            {pool.machineType || 'Machine type not reported'}
                          </small>
                        </div>
                        <StatusBadge status={pool.status} />
                      </div>
                      <dl className="node-pool-facts">
                        <div>
                          <dt>Configured</dt>
                          <dd>{pool.desiredCount}</dd>
                        </div>
                        <div>
                          <dt>Bounds</dt>
                          <dd>
                            {pool.minCount ?? 0}–{pool.maxCount ?? 'provider limit'}
                          </dd>
                        </div>
                        <div>
                          <dt>Autoscaling</dt>
                          <dd>{pool.autoscaling}</dd>
                        </div>
                      </dl>
                      {pool.zones.length > 0 && (
                        <p className="node-pool-note mono">{pool.zones.join(' · ')}</p>
                      )}
                      <div className="node-pool-scale">
                        <label className="field">
                          <span>Desired nodes</span>
                          <input
                            className="input"
                            type="number"
                            min={pool.minCount ?? 0}
                            max={pool.maxCount ?? undefined}
                            step="1"
                            value={desiredCounts[pool.id] ?? pool.desiredCount}
                            disabled={!pool.scalable || busy}
                            onChange={(event) =>
                              setDesiredCounts((current) => ({
                                ...current,
                                [pool.id]: event.target.value,
                              }))
                            }
                          />
                        </label>
                        <Button
                          variant="primary"
                          disabled={!pool.scalable || !changed || busy}
                          onClick={() => reviewScale(pool)}
                        >
                          Review scale
                        </Button>
                      </div>
                      {!pool.scalable && <p className="node-pool-note">{pool.unavailableReason}</p>}
                      {pool.autoscaling !== 'disabled' && (
                        <p className="node-pool-note">
                          Autoscaling may change this desired size later.
                        </p>
                      )}
                    </article>
                  )
                })}
              </div>
            ) : (
              <p className="sheet-empty">
                {details?.capability.reason || 'No provider-managed node pools were found.'}
              </p>
            )}
            {scaleMessage && (
              <p className="scale-message" role="status">
                {scaleMessage}
              </p>
            )}
          </section>

          <section className="sheet-section" aria-labelledby="networking-heading">
            <div className="sheet-section-heading">
              <h3 id="networking-heading">Networking</h3>
              <span className="tag">Read only</span>
            </div>
            {details && reportedConnectivityFacts.length > 0 ? (
              <>
                <dl className="fact-grid">
                  {reportedConnectivityFacts.map((fact) => (
                    <div key={fact.label}>
                      <dt>{fact.label}</dt>
                      <dd className="mono">{displayed(fact.value)}</dd>
                    </div>
                  ))}
                </dl>
                {unreportedConnectivityCount > 0 && (
                  <p className="node-pool-note">
                    {unreportedConnectivityCount} additional fields were not reported.
                  </p>
                )}
              </>
            ) : (
              <p className="sheet-empty">Networking details are unavailable.</p>
            )}
          </section>

          <section className="sheet-section" aria-labelledby="argo-heading">
            <h3 id="argo-heading">Argo CD</h3>
            {argoAccess ? (
              <div className="argo-access">
                <p>Open this cluster in Argo CD through KubeOps.</p>
                <a
                  className={buttonClass('secondary', 'sm')}
                  href={argoAccess.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open in Argo CD
                </a>
              </div>
            ) : (
              <p className="sheet-empty">{argoError || 'Loading Argo CD access…'}</p>
            )}
          </section>

          <div className="resource-id">
            <span>Provider resource ID</span>
            <code>{cluster.providerResourceId}</code>
          </div>
        </div>
      </Dialog>

      {/* A sibling of the sheet rather than a child of it. Radix stacks
          dismissable layers, so Escape here closes only this confirmation. */}
      <Dialog
        open={pending !== null}
        onOpenChange={(next) => !next && setPending(null)}
        size="sm"
        alert
        dismissible={!submitting}
      >
        {pending && (
          <>
            <header className="dialog-header">
              <div className="dialog-title-group">
                <p className="kicker">Review change</p>
                <DialogTitle asChild>
                  <h3>Scale {pending.pool.name}?</h3>
                </DialogTitle>
              </div>
            </header>
            <div className="dialog-body">
              <div className="scale-delta">
                <span>{pending.pool.desiredCount}</span>
                <i aria-hidden="true">→</i>
                <strong>{pending.desiredCount}</strong>
              </div>
              <DialogDescription asChild>
                <p>
                  This changes the configured capacity for <strong>{cluster.name}</strong> by{' '}
                  {pending.desiredCount - pending.pool.desiredCount} nodes.
                </p>
              </DialogDescription>
              {pending.desiredCount < pending.pool.desiredCount && (
                <p className="dialog-warning">
                  Scaling down can evict workloads from removed nodes.
                </p>
              )}
              {pending.pool.autoscaling !== 'disabled' && (
                <p className="dialog-warning">
                  Autoscaling is {pending.pool.autoscaling} and may override this size.
                </p>
              )}
            </div>
            <footer className="dialog-footer">
              <Button onClick={() => setPending(null)} disabled={submitting}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => void confirmScale()} loading={submitting}>
                {submitting ? 'Requesting…' : 'Confirm scale'}
              </Button>
            </footer>
          </>
        )}
      </Dialog>
    </>
  )
}
