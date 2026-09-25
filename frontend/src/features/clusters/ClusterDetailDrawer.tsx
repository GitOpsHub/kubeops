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
import { KubernetesLogo, ProviderLogo } from '../../components/BrandIcons'
import { ExternalLinkIcon, SyncIcon } from '../../components/icons'
import { StatusBadge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { buttonClass } from '../../components/ui/button-class'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { CopyButton } from '../../components/ui/CopyButton'
import { EmptyState } from '../../components/ui/EmptyState'
import { ErrorState } from '../../components/ui/ErrorState'
import { KeyValueList } from '../../components/ui/KeyValueList'
import { Sheet } from '../../components/ui/Sheet'
import { Skeleton } from '../../components/ui/Skeleton'
import { Timestamp } from '../../components/ui/Timestamp'
import { useToast } from '../../components/ui/toast-context'
import { providerLabels, providerNames } from '../../lib/providers'
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

/**
 * Where the configured size sits between the pool's bounds. Without a reported
 * maximum the scale stretches past the larger of min and desired, so the bar
 * still reads as "room to grow" rather than "full".
 */
function CapacityBar({ pool }: { pool: NodePool }) {
  const min = pool.minCount ?? 0
  const ceiling = pool.maxCount ?? Math.max(min, pool.desiredCount, 1) * 1.5
  const scale = Math.max(ceiling, pool.desiredCount, 1)
  const percent = (value: number) => `${Math.min(100, (value / scale) * 100)}%`
  return (
    <div className="capacity">
      <div
        className="capacity-track"
        role="img"
        aria-label={`${pool.desiredCount} configured nodes, bounds ${min} to ${
          pool.maxCount ?? 'the provider limit'
        }`}
      >
        <span className="capacity-fill" style={{ width: percent(pool.desiredCount) }} />
        {min > 0 && <span className="capacity-min" style={{ left: percent(min) }} />}
      </div>
      <div className="capacity-scale" aria-hidden="true">
        <span>min {min}</span>
        <strong>{pool.desiredCount} configured</strong>
        <span>max {pool.maxCount ?? '—'}</span>
      </div>
    </div>
  )
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
  // Validation stays beside the input; what the provider did is a toast.
  const [scaleError, setScaleError] = useState('')
  const toast = useToast()
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
        toast.info('Scaling is still continuing in the cloud provider.')
        setPollTarget(null)
        return
      }
      const next = await loadDetails(undefined, true)
      const pool = next?.nodePools.find((item) => item.id === pollTarget.pool.id)
      if (pool && pool.desiredCount === pollTarget.desiredCount && settled(pool.status)) {
        toast.success(`${pool.name} is now configured for ${pool.desiredCount} nodes.`)
        setPollTarget(null)
      }
    }
    const interval = window.setInterval(() => void poll(), 5_000)
    return () => window.clearInterval(interval)
  }, [loadDetails, pollTarget, toast])

  async function confirmScale() {
    if (!pending) return
    setSubmitting(true)
    try {
      const result = await scaleNodePool(cluster.id, pending.pool.id, pending.desiredCount)
      if (result.status === 'unchanged') {
        toast.info(`${pending.pool.name} is already configured for ${pending.desiredCount} nodes.`)
      } else {
        toast.info(`Scaling ${pending.pool.name} to ${pending.desiredCount} nodes…`)
        pollStartedAt.current = Date.now()
        setPollTarget(pending)
      }
      setPending(null)
      await loadDetails(undefined, true)
    } catch (error) {
      toast.error('The scaling request failed', {
        description: errorMessage(error, 'The provider rejected the request.'),
      })
    } finally {
      setSubmitting(false)
    }
  }

  function reviewScale(pool: NodePool) {
    const value = Number(desiredCounts[pool.id])
    if (!Number.isInteger(value) || value < 0) {
      setScaleError('Enter a nonnegative whole number of nodes.')
      return
    }
    setScaleError('')
    setPending({ pool, desiredCount: value })
  }

  const connectivityFacts = details ? networkFacts(details) : []
  const reportedConnectivityFacts = connectivityFacts.filter((fact) => isReported(fact.value))
  const unreportedConnectivityCount = connectivityFacts.length - reportedConnectivityFacts.length

  return (
    <>
      <Sheet
        open
        onOpenChange={(next) => !next && onClose()}
        size="lg"
        className="cluster-detail-modal"
        icon={
          <span className="cluster-sheet-logo">
            <KubernetesLogo className="cluster-sheet-logo-mark" />
            <ProviderLogo provider={cluster.provider} className="cluster-sheet-logo-badge" />
          </span>
        }
        kicker={`${providerLabels[cluster.provider]} · ${cluster.location}`}
        title={cluster.name}
        description={cluster.sourceName}
        actions={
          <StatusBadge domain="cluster" status={cluster.removedAt ? 'removed' : cluster.status} />
        }
        closeLabel="Close cluster details"
      >
        <div className="dialog-body cluster-sheet-body">
          <section className="sheet-section" aria-labelledby="cluster-state-heading">
            <h3 id="cluster-state-heading">Cluster state</h3>
            <KeyValueList
              className="cluster-facts"
              items={[
                { label: 'Kubernetes', value: cluster.kubernetesVersion || 'Unknown', mono: true },
                { label: 'Nodes', value: cluster.nodeCount ?? 'Not reported' },
                { label: 'Endpoint', value: cluster.endpointAccess },
                { label: 'Provider', value: providerNames[cluster.provider] },
                { label: 'First seen', value: <Timestamp value={cluster.firstSeenAt} /> },
                { label: 'Last seen', value: <Timestamp value={cluster.lastSeenAt} /> },
              ]}
            />
          </section>

          <section className="sheet-section" aria-labelledby="node-pools-heading">
            <div className="sheet-section-heading">
              <h3 id="node-pools-heading">Node pools</h3>
              {pollTarget && <StatusBadge domain="cluster" status="updating" />}
            </div>
            {loading ? (
              <div role="status" className="sheet-loading">
                <span className="sr-only">Loading live capacity…</span>
                <Skeleton height={120} radius="var(--radius-md)" />
              </div>
            ) : detailError ? (
              <ErrorState
                compact
                title="Live details could not be loaded"
                message={detailError}
                onRetry={() => void loadDetails()}
                retryLabel="Retry"
              />
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
                        <StatusBadge domain="cluster" status={pool.status} />
                      </div>
                      <CapacityBar pool={pool} />
                      <dl className="node-pool-facts">
                        <div>
                          <dt>Autoscaling</dt>
                          <dd>{pool.autoscaling}</dd>
                        </div>
                        <div className="node-pool-zones">
                          <dt>Zones</dt>
                          <dd className="mono">
                            {pool.zones.length > 0 ? pool.zones.join(' · ') : 'Not reported'}
                          </dd>
                        </div>
                      </dl>
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
                            aria-invalid={scaleError ? true : undefined}
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
              <EmptyState
                compact
                title="No node pools to manage"
                description={
                  details?.capability.reason || 'No provider-managed node pools were found.'
                }
              />
            )}
            {scaleError && (
              <p className="field-error" role="alert">
                {scaleError}
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
                <KeyValueList
                  className="cluster-network-facts"
                  items={reportedConnectivityFacts.map((fact) => ({
                    label: fact.label,
                    value: displayed(fact.value),
                    mono: true,
                  }))}
                />
                {unreportedConnectivityCount > 0 && (
                  <p className="node-pool-note">
                    {unreportedConnectivityCount} additional fields were not reported.
                  </p>
                )}
              </>
            ) : loading ? (
              <Skeleton height={64} radius="var(--radius-md)" />
            ) : (
              <EmptyState
                compact
                title="Networking details are unavailable"
                description="The provider did not report connectivity for this cluster."
              />
            )}
          </section>

          <section className="sheet-section" aria-labelledby="argo-heading">
            <h3 id="argo-heading">Argo CD</h3>
            {argoAccess ? (
              <div className="argo-access">
                <span className="argo-access-copy">
                  <SyncIcon className="argo-access-logo" aria-hidden="true" />
                  Open this cluster in Argo CD through KubeOps.
                </span>
                <a
                  className={buttonClass('secondary', 'sm')}
                  href={argoAccess.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open in Argo CD
                  <ExternalLinkIcon />
                </a>
              </div>
            ) : argoError ? (
              <ErrorState compact title="Argo CD access is unavailable" message={argoError} />
            ) : (
              <p className="sheet-loading-line" role="status">
                <span className="spinner" aria-hidden="true" />
                Loading Argo CD access…
              </p>
            )}
          </section>

          <div className="resource-id">
            <span>Provider resource ID</span>
            <span className="resource-id-value">
              <code>{cluster.providerResourceId}</code>
              <CopyButton value={cluster.providerResourceId} label="provider resource ID" />
            </span>
          </div>
        </div>
      </Sheet>

      {/* A sibling of the sheet rather than a child of it. Radix stacks
          dismissable layers, so Escape here closes only this confirmation. */}
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(next) => !next && setPending(null)}
        kicker="Review change"
        title={pending ? `Scale ${pending.pool.name}?` : ''}
        description={
          pending && (
            <>
              This changes the configured capacity for <strong>{cluster.name}</strong> by{' '}
              {pending.desiredCount - pending.pool.desiredCount} nodes.
            </>
          )
        }
        confirmLabel="Confirm scale"
        submittingLabel="Requesting…"
        submitting={submitting}
        onConfirm={() => void confirmScale()}
      >
        {pending && (
          <>
            <div className="scale-delta">
              <span>{pending.pool.desiredCount}</span>
              <i aria-hidden="true">→</i>
              <strong>{pending.desiredCount}</strong>
            </div>
            {pending.desiredCount < pending.pool.desiredCount && (
              <p className="dialog-warning">Scaling down can evict workloads from removed nodes.</p>
            )}
            {pending.pool.autoscaling !== 'disabled' && (
              <p className="dialog-warning">
                Autoscaling is {pending.pool.autoscaling} and may override this size.
              </p>
            )}
          </>
        )}
      </ConfirmDialog>
    </>
  )
}
