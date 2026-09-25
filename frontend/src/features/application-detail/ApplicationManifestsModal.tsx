import { useEffect, useState } from 'react'
import {
  getResourceManifestComparison,
  getTargetResources,
  type ApplicationDeployment,
  type ResourceNode,
} from '../../api/onboarding'
import { errorMessage, isAbortError } from '../../api/client'
import { KubernetesResourceIcon } from '../../components/KubernetesResourceIcon'
import { ManifestCode } from '../../components/ManifestCode'
import { StatusBadge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Dialog, DialogClose, DialogDescription, DialogTitle } from '../../components/ui/Dialog'
import { Skeleton } from '../../components/ui/Skeleton'
import { buildManifestDiff, prepareManifestPair } from '../../lib/resource-diff'
import { toRef } from '../resources/resource-ref'
import './manifests.css'

type Props = {
  onboardingId: string
  namespace: string
  targets: ApplicationDeployment[]
  onClose: () => void
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

export function ApplicationManifestsModal({ onboardingId, namespace, targets, onClose }: Props) {
  const [selectedTargetId, setSelectedTargetId] = useState(targets[0]?.id ?? '')
  const [nodes, setNodes] = useState<ResourceNode[]>([])
  const [selectedUid, setSelectedUid] = useState('')
  const [desiredManifest, setDesiredManifest] = useState('')
  const [liveManifest, setLiveManifest] = useState('')
  // Which resource the manifests above belong to. Until it matches the
  // selection the pane is loading, so an empty diff never flashes between a
  // selection and its request starting.
  const [loadedUid, setLoadedUid] = useState('')
  const [hideGeneratedFields, setHideGeneratedFields] = useState(true)
  const [resourcesLoading, setResourcesLoading] = useState(true)
  const [manifestLoading, setManifestLoading] = useState(false)
  const [error, setError] = useState('')
  const target = targets.find((candidate) => candidate.id === selectedTargetId) ?? targets[0]
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
        if (!isAbortError(loadError))
          setError(errorMessage(loadError, 'Resources could not be loaded'))
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
          setLoadedUid(selectedNode.uid)
        }
      })
      .catch((loadError) => {
        if (!isAbortError(loadError))
          setError(errorMessage(loadError, 'The manifest is unavailable'))
      })
      .finally(() => {
        if (!controller.signal.aborted) setManifestLoading(false)
      })

    return () => controller.abort()
  }, [onboardingId, selectedNode, targetId])

  if (!target) return null

  const deploymentSync = syncLabel(target)
  const preparedManifests = prepareManifestPair(desiredManifest, liveManifest, hideGeneratedFields)
  const diffRows = buildManifestDiff(preparedManifests.desired, preparedManifests.live)
  const changedRows = diffRows.filter((row) => row.tone !== 'same').length
  const generatedResource = !desiredManifest.trim()

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()} size="xl" className="manifests-modal">
      <header className="dialog-header manifests-header">
        <div className="dialog-title-group">
          <p className="kicker">Reconciliation diff</p>
          <DialogTitle asChild>
            <h2>Kubernetes manifests</h2>
          </DialogTitle>
          <DialogDescription asChild>
            <p className="subtle">Compare Helm output with the object running in the cluster.</p>
          </DialogDescription>
        </div>
        <div className="manifests-deployment">
          <span className="resource-mark" aria-hidden="true">
            <KubernetesResourceIcon kind="Deployment" />
          </span>
          <div className="cell-stack">
            <small>Deployed to</small>
            <strong>{target.clusterName}</strong>
            <small className="mono">{namespace}</small>
          </div>
          <StatusBadge domain="sync" status={deploymentSync} />
        </div>
      </header>

      <div className="manifests-targets" role="group" aria-label="Deployment cluster">
        {targets.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            className={
              candidate.id === target.id ? 'target-switch-item is-active' : 'target-switch-item'
            }
            aria-pressed={candidate.id === target.id}
            onClick={() => setSelectedTargetId(candidate.id)}
          >
            {candidate.clusterName}
          </button>
        ))}
      </div>

      <section className="manifests-document" aria-label="Selected resource diff">
        <div className="manifests-toolbar">
          <div className="manifests-strip" role="tablist" aria-label="Resource manifests">
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
                <span className="cell-stack">
                  <small>{node.kind}</small>
                  <strong className="mono truncate">{node.name}</strong>
                </span>
              </button>
            ))}
          </div>
          <div className="manifests-toolbar-actions">
            {selectedNode && (
              <span className="tag tag--mono">
                {selectedNode.group
                  ? `${selectedNode.group}/${selectedNode.version}`
                  : selectedNode.version}
              </span>
            )}
            <Button
              size="sm"
              className={hideGeneratedFields ? 'manifest-filter is-active' : 'manifest-filter'}
              aria-pressed={hideGeneratedFields}
              onClick={() => setHideGeneratedFields((current) => !current)}
            >
              {hideGeneratedFields ? 'Generated fields hidden' : 'Hide generated fields'}
            </Button>
          </div>
        </div>
        {!error &&
        (manifestLoading ||
          resourcesLoading ||
          (selectedNode && loadedUid !== selectedNode.uid)) ? (
          <div className="code-pane-state" role="status">
            <span className="sr-only">Loading desired and live manifests…</span>
            <Skeleton height={12} width="45%" />
            <Skeleton height={12} width="70%" />
            <Skeleton height={12} width="60%" />
          </div>
        ) : error ? (
          <div className="code-pane-state code-pane-state--error" role="alert">
            {error}
          </div>
        ) : selectedNode && generatedResource ? (
          // A controller-made object has no Helm side to compare, so a diff
          // would be half empty: show the live object as plain YAML instead.
          <div
            className="manifest-diff manifest-diff--single"
            aria-label={`Manifest diff for ${selectedNode.name}`}
          >
            <div className="manifest-diff-summary">
              <span>
                Generated by a Kubernetes controller, so there is no Helm output to compare
              </span>
            </div>
            <ManifestCode
              code={preparedManifests.live}
              label={`Live YAML for ${selectedNode.name} on ${target.clusterName}`}
            />
          </div>
        ) : selectedNode ? (
          <div className="manifest-diff" aria-label={`Manifest diff for ${selectedNode.name}`}>
            <div className="manifest-diff-columns">
              <div>
                <span className="manifest-diff-source manifest-diff-source--desired">Desired</span>
                <strong>Helm rendered</strong>
              </div>
              <div>
                <span className="manifest-diff-source manifest-diff-source--live">Live</span>
                <strong>{target.clusterName}</strong>
              </div>
            </div>
            <div className="manifest-diff-summary">
              {changedRows === 0 ? (
                <span className="manifest-diff-clean">No declared drift</span>
              ) : (
                <span>
                  {changedRows} changed {changedRows === 1 ? 'line' : 'lines'}
                </span>
              )}
              {hideGeneratedFields && <span>Runtime metadata and defaulted fields are hidden</span>}
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
          <div className="code-pane-state">No resources reported</div>
        )}
      </section>

      <footer className="dialog-footer">
        <span className="dialog-footer-note">
          {nodes.length} {nodes.length === 1 ? 'resource' : 'resources'} · {deploymentSync}
        </span>
        <DialogClose asChild>
          <Button>Close</Button>
        </DialogClose>
      </footer>
    </Dialog>
  )
}
