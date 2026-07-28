import { useCallback, useEffect, useRef, useState } from 'react'
import {
  deleteResource,
  getResourceManifest,
  getTargetResources,
  type ApplicationDeployment,
  type ResourceNode,
  type ResourceRef,
} from '../api/onboarding'
import { useStoredPreference } from '../hooks/useStoredPreference'
import { buildResourceTree } from '../lib/resource-tree'
import { ResourceGraph } from './ResourceGraph'
import { ResourceTable } from './ResourceTable'
import { StatusBadge } from './StatusBadge'

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
        <ResourceDrawer
          node={selected}
          onboardingId={onboardingId}
          targetId={target.id}
          onClose={() => setSelected(null)}
          onDelete={() => setPendingDelete(selected)}
        />
      )}

      {pendingDelete && (
        <div className="confirmation-backdrop" role="presentation">
          <section
            className="scale-confirmation"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-resource-title"
          >
            <p className="section-label">Confirm deletion</p>
            <h3 id="delete-resource-title">
              Delete {pendingDelete.kind} {pendingDelete.name}?
            </h3>
            <p>
              This removes the live object from <strong>{target.clusterName}</strong>. It does not
              change Git, so Argo CD recreates it on the next sync if the application still
              declares it.
            </p>
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
          </section>
        </div>
      )}
    </div>
  )
}

type DrawerProps = {
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
function formatManifest(manifest: string) {
  try {
    return JSON.stringify(JSON.parse(manifest), null, 2)
  } catch {
    return manifest
  }
}

/**
 * One detail surface for both views. A card on a positioned canvas has nowhere
 * to expand into, and sharing the drawer keeps the two views behaving alike.
 */
function ResourceDrawer({ node, onboardingId, targetId, onClose, onDelete }: DrawerProps) {
  const [manifest, setManifest] = useState('')
  const [manifestError, setManifestError] = useState('')
  const [loading, setLoading] = useState(false)
  const closeButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeButton.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // A different resource is a different manifest, so the old one cannot linger.
  useEffect(() => {
    setManifest('')
    setManifestError('')
  }, [node.uid])

  async function loadManifest() {
    setLoading(true)
    setManifestError('')
    try {
      setManifest(formatManifest(await getResourceManifest(onboardingId, targetId, toRef(node))))
    } catch (error) {
      setManifestError(error instanceof Error ? error.message : 'The manifest is unavailable')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="drawer-backdrop" role="presentation" onMouseDown={onClose}>
      <aside
        className="detail-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="resource-detail-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          ref={closeButton}
          className="drawer-close"
          type="button"
          onClick={onClose}
          aria-label="Close resource details"
        >
          ×
        </button>

        <header className="drawer-identity">
          <div>
            <p className="section-label">{node.kind}</p>
            <h2 id="resource-detail-title">{node.name}</h2>
          </div>
        </header>

        <dl className="fact-list">
          <div>
            <dt>API version</dt>
            <dd className="mono">{node.group ? `${node.group}/${node.version}` : node.version}</dd>
          </div>
          <div>
            <dt>Namespace</dt>
            <dd className="mono">{node.namespace || 'cluster-scoped'}</dd>
          </div>
          <div>
            <dt>Health</dt>
            <dd>
              {node.healthStatus && node.healthStatus !== 'Unknown' ? (
                <StatusBadge status={node.healthStatus} />
              ) : (
                'Not reported'
              )}
            </dd>
          </div>
          <div>
            <dt>Sync</dt>
            <dd>{node.syncStatus || 'Not tracked directly'}</dd>
          </div>
          {node.images && node.images.length > 0 && (
            <div>
              <dt>Images</dt>
              <dd className="mono">{node.images.join(', ')}</dd>
            </div>
          )}
          {node.info?.map((item) => (
            <div key={item.name}>
              <dt>{item.name}</dt>
              <dd className="mono">{item.value}</dd>
            </div>
          ))}
        </dl>

        {manifest ? (
          <pre className="resource-manifest" aria-label={`Manifest for ${node.name}`}>
            {manifest}
          </pre>
        ) : (
          <div className="resource-manifest-actions">
            <button
              type="button"
              className="ghost-button"
              disabled={loading}
              onClick={() => void loadManifest()}
            >
              {loading ? 'Loading manifest…' : 'Show live manifest'}
            </button>
            {manifestError && <span className="quiet-note">{manifestError}</span>}
          </div>
        )}

        <div className="drawer-danger">
          <button type="button" className="danger-button" onClick={onDelete}>
            Delete resource
          </button>
        </div>
      </aside>
    </div>
  )
}
