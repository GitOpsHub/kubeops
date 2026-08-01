import { useEffect, useState } from 'react'
import {
  getResourceManifestComparison,
  getTargetResources,
  type ApplicationDeployment,
  type ResourceNode,
  type ResourceRef,
} from '../api/onboarding'
import { buildManifestDiff, prepareManifestPair } from '../lib/resource-diff'
import { KubernetesResourceIcon } from './KubernetesResourceIcon'
import { StatusBadge } from './StatusBadge'
import { Dialog, DialogClose, DialogDescription, DialogTitle } from './ui/Dialog'

type Props = {
  onboardingId: string
  namespace: string
  targets: ApplicationDeployment[]
  onClose: () => void
}

function toRef(node: ResourceNode): ResourceRef {
  return {
    group: node.group,
    version: node.version,
    kind: node.kind,
    namespace: node.namespace,
    name: node.name,
  }
}

function syncLabel(target: ApplicationDeployment) {
  return target.syncStatus.trim().toLowerCase().replace(/\s+/g, '') === 'synced'
    ? 'Synced'
    : 'Out of Sync'
}

function isDeclarativeManifest(node: ResourceNode) {
  const kind = node.kind.trim().toLowerCase()
  return kind !== 'pod' && kind !== 'replicaset'
}

export function ApplicationManifestsModal({
  onboardingId,
  namespace,
  targets,
  onClose,
}: Props) {
  const [selectedTargetId, setSelectedTargetId] = useState(targets[0]?.id ?? '')
  const [nodes, setNodes] = useState<ResourceNode[]>([])
  const [selectedUid, setSelectedUid] = useState('')
  const [desiredManifest, setDesiredManifest] = useState('')
  const [liveManifest, setLiveManifest] = useState('')
  const [hideGeneratedFields, setHideGeneratedFields] = useState(true)
  const [resourcesLoading, setResourcesLoading] = useState(true)
  const [manifestLoading, setManifestLoading] = useState(false)
  const [error, setError] = useState('')
  const target =
    targets.find((candidate) => candidate.id === selectedTargetId) ?? targets[0]
  const targetId = target?.id ?? ''
  const selectedNode = nodes.find((node) => node.uid === selectedUid) ?? nodes[0]

  useEffect(() => {
    if (!targetId) return
    const controller = new AbortController()
    setResourcesLoading(true)
    setNodes([])
    setSelectedUid('')
    setDesiredManifest('')
    setLiveManifest('')
    setError('')

    void getTargetResources(onboardingId, targetId, controller.signal)
      .then((items) => {
        if (controller.signal.aborted) return
        const ordered = items
          .filter(isDeclarativeManifest)
          .sort(
            (left, right) =>
              left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name),
          )
        setNodes(ordered)
        setSelectedUid(ordered[0]?.uid ?? '')
      })
      .catch((loadError) => {
        if (!(loadError instanceof DOMException && loadError.name === 'AbortError')) {
          setError(
            loadError instanceof Error ? loadError.message : 'Resources could not be loaded',
          )
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setResourcesLoading(false)
      })

    return () => controller.abort()
  }, [onboardingId, targetId])

  useEffect(() => {
    if (!targetId || !selectedNode) return
    const controller = new AbortController()
    setManifestLoading(true)
    setDesiredManifest('')
    setLiveManifest('')
    setError('')

    void getResourceManifestComparison(
      onboardingId,
      targetId,
      toRef(selectedNode),
      controller.signal,
    )
      .then((nextManifest) => {
        if (!controller.signal.aborted) {
          setDesiredManifest(nextManifest.desiredManifest)
          setLiveManifest(nextManifest.manifest)
        }
      })
      .catch((loadError) => {
        if (!(loadError instanceof DOMException && loadError.name === 'AbortError')) {
          setError(
            loadError instanceof Error ? loadError.message : 'The manifest is unavailable',
          )
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setManifestLoading(false)
      })

    return () => controller.abort()
  }, [onboardingId, selectedNode, targetId])

  if (!target) return null

  const deploymentSync = syncLabel(target)
  const preparedManifests = prepareManifestPair(
    desiredManifest,
    liveManifest,
    hideGeneratedFields,
  )
  const diffRows = buildManifestDiff(
    preparedManifests.desired,
    preparedManifests.live,
  )
  const changedRows = diffRows.filter((row) => row.tone !== 'same').length
  const generatedResource = !desiredManifest.trim()

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      backdropClassName="resource-modal-backdrop"
      className="resource-modal application-manifests-modal"
    >
        <header className="application-manifests-header">
          <div>
            <p className="section-label">Reconciliation diff</p>
            <DialogTitle asChild>
              <h2>Kubernetes manifests</h2>
            </DialogTitle>
            <DialogDescription asChild>
              <p className="application-manifests-subtitle">
                Compare Helm output with the object running in the cluster.
              </p>
            </DialogDescription>
          </div>
          <div className="application-manifests-deployment">
            <span className="resource-modal-mark" aria-hidden="true">
              <KubernetesResourceIcon kind="Deployment" />
            </span>
            <div>
              <span>Deployed to</span>
              <strong>{target.clusterName}</strong>
              <small>{namespace}</small>
            </div>
            <StatusBadge
              status={deploymentSync}
              tone={deploymentSync === 'Synced' ? 'ok' : 'warn'}
            />
          </div>
        </header>

        <div className="application-manifest-targets" role="group" aria-label="Deployment cluster">
          {targets.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              className={candidate.id === target.id ? 'is-active' : ''}
              aria-pressed={candidate.id === target.id}
              onClick={() => setSelectedTargetId(candidate.id)}
            >
              {candidate.clusterName}
            </button>
          ))}
        </div>

        <div className="application-manifests-layout">
          <section className="application-manifest-document" aria-label="Selected resource diff">
            <div className="application-manifest-document-heading">
              <div
                className="application-manifest-resource-strip"
                role="tablist"
                aria-label="Resource manifests"
              >
                {nodes.map((node) => (
                  <button
                    key={node.uid}
                    type="button"
                    role="tab"
                    aria-label={`${node.kind} ${node.name}`}
                    aria-selected={node.uid === selectedNode?.uid}
                    className={node.uid === selectedNode?.uid ? 'is-active' : ''}
                    title={`${node.kind} · ${node.name}`}
                    onClick={() => setSelectedUid(node.uid)}
                  >
                    <KubernetesResourceIcon kind={node.kind} />
                    <span>
                      <small>{node.kind}</small>
                      <strong>{node.name}</strong>
                    </span>
                  </button>
                ))}
              </div>
              <div className="application-manifest-document-actions">
                {selectedNode && (
                  <span className="application-manifest-api">
                    {selectedNode.group
                      ? `${selectedNode.group}/${selectedNode.version}`
                      : selectedNode.version}
                  </span>
                )}
                <button
                  type="button"
                  className={`manifest-filter ${hideGeneratedFields ? 'is-active' : ''}`}
                  aria-pressed={hideGeneratedFields}
                  onClick={() => setHideGeneratedFields((current) => !current)}
                >
                  <svg viewBox="0 0 20 20" aria-hidden="true">
                    <path d="M3 4h14l-5.4 6.1v4.6l-3.2 1.6v-6.2L3 4Z" />
                  </svg>
                  {hideGeneratedFields ? 'Generated fields hidden' : 'Hide generated fields'}
                </button>
              </div>
            </div>
            {manifestLoading || resourcesLoading ? (
              <div className="resource-modal-state" role="status">
                <span className="loader" aria-hidden="true" />
                Loading desired and live manifests…
              </div>
            ) : error ? (
              <div className="resource-modal-state" role="alert">{error}</div>
            ) : selectedNode ? (
              <div
                className="manifest-diff"
                aria-label={`Manifest diff for ${selectedNode.name}`}
              >
                <div className="manifest-diff-columns">
                  <div>
                    <span className="manifest-diff-source manifest-diff-source--desired">
                      Desired
                    </span>
                    <strong>Helm rendered</strong>
                  </div>
                  <div>
                    <span className="manifest-diff-source manifest-diff-source--live">
                      Live
                    </span>
                    <strong>{target.clusterName}</strong>
                  </div>
                </div>
                <div className="manifest-diff-summary">
                  {generatedResource ? (
                    <span>Generated by a Kubernetes controller</span>
                  ) : changedRows === 0 ? (
                    <span className="manifest-diff-clean">No declared drift</span>
                  ) : (
                    <span>{changedRows} changed {changedRows === 1 ? 'line' : 'lines'}</span>
                  )}
                  {hideGeneratedFields && !generatedResource && (
                    <span>Runtime metadata and defaulted fields are hidden</span>
                  )}
                </div>
                <div className="manifest-diff-code" role="table">
                  {diffRows.map((row, index) => (
                    <div
                      className={`manifest-diff-row manifest-diff-row--${row.tone}`}
                      role="row"
                      key={`${index}-${row.leftLine ?? 'x'}-${row.rightLine ?? 'x'}`}
                    >
                      <span className="manifest-diff-line" role="cell">
                        {row.leftLine ?? ''}
                      </span>
                      <code className="manifest-diff-cell" role="cell">
                        {row.leftText ?? ''}
                      </code>
                      <span className="manifest-diff-line" role="cell">
                        {row.rightLine ?? ''}
                      </span>
                      <code className="manifest-diff-cell" role="cell">
                        {row.rightText ?? ''}
                      </code>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="resource-modal-state">No resources reported</div>
            )}
          </section>
        </div>

        <footer className="application-manifests-footer">
          <span>
            {nodes.length} {nodes.length === 1 ? 'resource' : 'resources'} · {deploymentSync}
          </span>
          <DialogClose asChild>
            <button type="button" className="ghost-button">
              Close
            </button>
          </DialogClose>
        </footer>
    </Dialog>
  )
}
