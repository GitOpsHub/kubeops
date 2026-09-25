import { useCallback, useState } from 'react'
import { errorMessage } from '../../api/client'
import {
  deleteResource,
  getTargetResources,
  type ApplicationDeployment,
  type ResourceNode,
} from '../../api/onboarding'
import { Banner } from '../../components/ui/Banner'
import { EmptyState } from '../../components/ui/EmptyState'
import { RefreshIndicator } from '../../components/ui/RefreshIndicator'
import { SegmentedControl } from '../../components/ui/SegmentedControl'
import { Skeleton } from '../../components/ui/Skeleton'
import { useToast } from '../../components/ui/toast-context'
import { LogsSheet } from '../log-viewer/LogsSheet'
import { usePolledResource } from '../../hooks/usePolledResource'
import { useStoredPreference } from '../../hooks/useStoredPreference'
import { buildResourceTree } from '../../lib/resource-tree'
import { DeleteResourceDialog } from './DeleteResourceDialog'
import { ResourceGraph } from './ResourceGraph'
import { ResourceManifestModal } from './ResourceManifestModal'
import { ResourceTable } from './ResourceTable'
import { toRef } from './resource-ref'
import './resources.css'

const pollIntervalMs = 15_000
const viewStorageKey = 'kubeops-resource-view'

type View = 'graph' | 'list'

type Props = {
  onboardingId: string
  target: ApplicationDeployment
}

/**
 * Owns everything the graph and the list share: loading and polling, the
 * selected resource, deletion, and the view toggle. The two views are purely
 * presentational so they cannot drift on behaviour.
 */
export function ResourceExplorer({ onboardingId, target }: Props) {
  const [view, setView] = useStoredPreference<View>(viewStorageKey, 'graph')
  const [selected, setSelected] = useState<ResourceNode | null>(null)
  const [pendingDelete, setPendingDelete] = useState<ResourceNode | null>(null)
  const [logNode, setLogNode] = useState<ResourceNode | null>(null)
  const [deleting, setDeleting] = useState(false)
  const toast = useToast()

  const load = useCallback(
    (signal: AbortSignal) => getTargetResources(onboardingId, target.id, signal),
    [onboardingId, target.id],
  )
  const resources = usePolledResource(load, { intervalMs: pollIntervalMs })
  const nodes = resources.data ?? []

  async function confirmDelete() {
    if (!pendingDelete) return
    setDeleting(true)
    try {
      await deleteResource(onboardingId, target.id, toRef(pendingDelete))
      toast.success(
        `${pendingDelete.kind} ${pendingDelete.name} was deleted from ${target.clusterName}.`,
        { description: 'Argo CD restores it on the next sync if Git still declares it.' },
      )
      if (selected?.uid === pendingDelete.uid) setSelected(null)
      setPendingDelete(null)
      await resources.reload()
    } catch (error) {
      toast.error('The resource could not be deleted', {
        description: errorMessage(error, 'The cluster rejected the request.'),
      })
      setPendingDelete(null)
    } finally {
      setDeleting(false)
    }
  }

  // Ordering is depth-first in both views, so the DOM always reads owner first.
  const ordered = buildResourceTree(nodes)

  if (resources.loading) {
    return (
      <div className="resource-loading" role="status">
        <span className="sr-only">Loading resources…</span>
        <Skeleton height={40} radius="var(--radius-md)" />
        <Skeleton height={280} radius="var(--radius-lg)" />
      </div>
    )
  }

  return (
    <div className="resource-explorer">
      {resources.error && (
        <Banner
          tone="error"
          title="Resources could not be loaded"
          onRetry={() => void resources.reload()}
        >
          {resources.error.message}
        </Banner>
      )}

      <div className="resource-toolbar">
        <SegmentedControl<View>
          label="Resource view"
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: 'graph', label: 'Tree' },
            { value: 'list', label: 'List' },
          ]}
        />
        <RefreshIndicator
          lastUpdated={resources.lastUpdated}
          refreshing={resources.refreshing}
          failed={Boolean(resources.error)}
        />
      </div>

      {ordered.length === 0 && !resources.error ? (
        <div className="panel">
          <EmptyState
            title="No resources reported"
            description="Argo CD has not observed any objects for this application yet. Deploy it to start a sync."
          />
        </div>
      ) : view === 'graph' ? (
        <ResourceGraph
          nodes={nodes}
          selectedUid={selected?.uid}
          onSelect={setSelected}
          onDelete={setPendingDelete}
          onLogs={setLogNode}
          label={`Resources on ${target.clusterName}`}
        />
      ) : (
        <ResourceTable
          nodes={ordered}
          onSelect={setSelected}
          onDelete={setPendingDelete}
          onLogs={setLogNode}
        />
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

      {logNode && (
        <LogsSheet
          onboardingId={onboardingId}
          targetId={target.id}
          clusterName={target.clusterName}
          resource={toRef(logNode)}
          onClose={() => setLogNode(null)}
        />
      )}

      <DeleteResourceDialog
        node={pendingDelete}
        clusterName={target.clusterName}
        deleting={deleting}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  )
}
