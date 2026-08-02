import { useCallback, useEffect, useState } from 'react'
import {
  deleteResource,
  getResourceManifest,
  getTargetResources,
  type ApplicationDeployment,
  type ResourceNode,
  type ResourceRef,
} from '../api/onboarding'
import { useStoredPreference } from '../hooks/useStoredPreference'
import { formatResourceManifest } from '../lib/resource-manifest'
import { buildResourceTree } from '../lib/resource-tree'
import { KubernetesResourceIcon } from './KubernetesResourceIcon'
import { ResourceGraph } from './ResourceGraph'
import { ResourceTable } from './ResourceTable'
import { StatusBadge } from './StatusBadge'
import { Dialog, DialogClose, DialogDescription, DialogTitle } from './ui/Dialog'

const pollIntervalMs = 15_000
const viewStorageKey = 'kubeops-resource-view'

type View = 'graph' | 'list'

type Props = {
  onboardingId: string
  target: ApplicationDeployment
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

/**
 * Owns everything the graph and the list share: loading and polling, the
 * selected resource, deletion, and the view toggle. The two views are purely
 * presentational so they cannot drift on behaviour.
 */
export function ResourceExplorer({ onboardingId, target }: Props) {
  const [view, setView] = useStoredPreference<View>(viewStorageKey, 'graph')
  const [nodes, setNodes] = useState<ResourceNode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<ResourceNode | null>(null)
  const [pendingDelete, setPendingDelete] = useState<ResourceNode | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [notice, setNotice] = useState('')

  const load = useCallback(
    async (signal?: AbortSignal, quiet = false) => {
      if (!quiet) setLoading(true)
      try {
        setNodes(await getTargetResources(onboardingId, target.id, signal))
        setError('')
      } catch (loadError) {
        if (loadError instanceof DOMException && loadError.name === 'AbortError') return
        setError(loadError instanceof Error ? loadError.message : 'Resources could not be loaded')
      } finally {
        if (!quiet) setLoading(false)
      }
    },
    [onboardingId, target.id],
  )

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    const interval = window.setInterval(() => void load(undefined, true), pollIntervalMs)
    return () => {
      controller.abort()
      window.clearInterval(interval)
    }
  }, [load])

  async function confirmDelete() {
    if (!pendingDelete) return
    setDeleting(true)
    try {
      await deleteResource(onboardingId, target.id, toRef(pendingDelete))
      setNotice(
        `${pendingDelete.kind} ${pendingDelete.name} was deleted from ${target.clusterName}.`,
      )
      if (selected?.uid === pendingDelete.uid) setSelected(null)
      setPendingDelete(null)
      await load(undefined, true)
    } catch (deleteError) {
      setError(
        deleteError instanceof Error ? deleteError.message : 'The resource could not be deleted',
      )
    } finally {
      setDeleting(false)
    }
  }

  // Ordering is depth-first in both views, so the DOM always reads owner first.
  const ordered = buildResourceTree(nodes)

  if (loading && nodes.length === 0) {
    return (
      <div className="table-state" role="status">
        <span className="loader" aria-hidden="true" />
        Loading resources…
      </div>
    )
  }

  return (
    <div className="resource-explorer">
      {error && (
        <div className="error-banner" role="alert">
          <div>
            <strong>Resources could not be loaded</strong>
            <span>{error}</span>
          </div>
          <button type="button" className="text-button" onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}

      {notice && (
        <div className="success-banner" role="status">
          <div>
            <strong>Resource deleted</strong>
            <span>{notice} Argo CD restores it on the next sync if Git still declares it.</span>
          </div>
          <button type="button" className="text-button" onClick={() => setNotice('')}>
            Dismiss
          </button>
        </div>
      )}

      <div className="view-toggle" role="group" aria-label="Resource view">
        <button
          type="button"
          className={view === 'graph' ? 'is-active' : ''}
          aria-pressed={view === 'graph'}
          onClick={() => setView('graph')}
        >
          Tree
        </button>
        <button
          type="button"
          className={view === 'list' ? 'is-active' : ''}
          aria-pressed={view === 'list'}
          onClick={() => setView('list')}
        >
          List
        </button>
      </div>

      {ordered.length === 0 && !error ? (
        <div className="empty-panel">
          <strong>No resources reported</strong>
          <span>Argo CD has not observed any objects for this application yet.</span>
        </div>
      ) : view === 'graph' ? (
        <ResourceGraph
          nodes={nodes}
          selectedUid={selected?.uid}
          onSelect={setSelected}
          label={`Resources on ${target.clusterName}`}
        />
      ) : (
        <ResourceTable nodes={ordered} onSelect={setSelected} onDelete={setPendingDelete} />
      )}

      {selected && (
        <ResourceManifestModal
          node={selected}
          onboardingId={onboardingId}
          targetId={target.id}
          onClose={() => setSelected(null)}
          onDelete={() => {
            setPendingDelete(selected)
            setSelected(null)
          }}
        />
      )}

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(next) => !next && setPendingDelete(null)}
        backdropClassName="confirmation-backdrop"
        className="scale-confirmation"
        alert
        dismissible={!deleting}
      >
        {pendingDelete && (
          <>
            <p className="section-label">Confirm deletion</p>
            <DialogTitle asChild>
              <h3>
                Delete {pendingDelete.kind} {pendingDelete.name}?
              </h3>
            </DialogTitle>
            <DialogDescription asChild>
              <p>
                This removes the live object from <strong>{target.clusterName}</strong>. It does not
                change Git, so Argo CD recreates it on the next sync if the application still
                declares it.
              </p>
            </DialogDescription>
            {pendingDelete.kind === 'Namespace' ||
            pendingDelete.kind === 'PersistentVolumeClaim' ? (
              <p className="confirmation-warning">
                Deleting a {pendingDelete.kind} can destroy data that is not recoverable by a sync.
              </p>
            ) : null}
            <div className="confirmation-actions">
              <button type="button" disabled={deleting} onClick={() => setPendingDelete(null)}>
                Cancel
              </button>
              {/* Names the kind so it is never confused with the button in the
                  drawer that opened this dialog. */}
              <button
                type="button"
                className="danger-button"
                disabled={deleting}
                onClick={() => void confirmDelete()}
              >
                {deleting ? 'Deleting…' : `Delete ${pendingDelete.kind}`}
              </button>
            </div>
          </>
        )}
      </Dialog>
    </div>
  )
}

type ModalProps = {
  node: ResourceNode
  onboardingId: string
  targetId: string
  onClose: () => void
  onDelete: () => void
}

/**
 * Argo CD returns the live manifest as a single-line JSON string, which is
 * unreadable as-is. Anything that does not parse is shown untouched rather than
 * discarded.
 */
/**
 * Selecting a resource opens its live YAML immediately in one focused modal.
 * The graph and list share this surface so their behaviour cannot drift.
 */
function ResourceManifestModal({
  node,
  onboardingId,
  targetId,
  onClose,
  onDelete,
}: ModalProps) {
  const [manifest, setManifest] = useState('')
  const [manifestError, setManifestError] = useState('')
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    const controller = new AbortController()
    setManifest('')
    setManifestError('')
    setLoading(true)

    void getResourceManifest(onboardingId, targetId, toRef(node), controller.signal)
      .then((nextManifest) => {
        if (!controller.signal.aborted) setManifest(formatResourceManifest(nextManifest))
      })
      .catch((error) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setManifestError(error instanceof Error ? error.message : 'The manifest is unavailable')
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })

    return () => controller.abort()
  }, [node, onboardingId, targetId])

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      backdropClassName="resource-modal-backdrop"
      className="resource-modal"
      describedBy={undefined}
    >
        <header className="resource-modal-header">
          <div className="resource-modal-title">
            <span className="resource-modal-mark" aria-hidden="true">
              <KubernetesResourceIcon kind={node.kind} />
            </span>
            <div>
              <p className="section-label">{node.kind} YAML</p>
              <DialogTitle asChild>
                <h2 title={node.name}>{node.name}</h2>
              </DialogTitle>
            </div>
          </div>
        </header>

        <div className="resource-modal-meta">
          <span>{node.group ? `${node.group}/${node.version}` : node.version}</span>
          <span>{node.namespace || 'cluster-scoped'}</span>
          {node.healthStatus && node.healthStatus !== 'Unknown' && (
            <StatusBadge status={node.healthStatus} />
          )}
          {node.syncStatus && <span>{node.syncStatus}</span>}
        </div>

        <div className="resource-modal-body">
          {loading ? (
            <div className="resource-modal-state" role="status">
              <span className="loader" aria-hidden="true" />
              Loading live YAML…
            </div>
          ) : manifestError ? (
            <div className="resource-modal-state" role="alert">
              {manifestError}
            </div>
          ) : (
            <pre className="resource-manifest" aria-label={`YAML for ${node.name}`}>
              {manifest}
            </pre>
          )}
        </div>

        <footer className="resource-modal-footer">
          <button
            type="button"
            className="danger-button resource-modal-delete"
            onClick={onDelete}
            aria-label="Delete resource"
            title="Delete resource"
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M3.5 5.5h13M8 3.5h4M5.5 5.5l.7 11h7.6l.7-11M8 8.5v5M12 8.5v5" />
            </svg>
          </button>
          <DialogClose asChild>
            <button type="button" className="ghost-button">
              Close
            </button>
          </DialogClose>
        </footer>
    </Dialog>
  )
}
