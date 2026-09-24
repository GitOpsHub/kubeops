import { useEffect, useState } from 'react'
import { errorMessage, isAbortError } from '../../api/client'
import { getResourceManifest, type ResourceNode } from '../../api/onboarding'
import { KubernetesResourceIcon } from '../../components/KubernetesResourceIcon'
import { StatusBadge, Tag } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { DeleteIcon } from '../../components/icons'
import { Dialog, DialogClose } from '../../components/ui/Dialog'
import { DialogFooter, DialogHeader } from '../../components/ui/DialogParts'
import { Skeleton } from '../../components/ui/Skeleton'
import { formatResourceManifest } from '../../lib/resource-manifest'
import { toRef } from './resource-ref'

type Props = {
  node: ResourceNode
  onboardingId: string
  targetId: string
  onClose: () => void
  onDelete: () => void
}

/**
 * Selecting a resource opens its live YAML in one focused modal. The graph and
 * the list share this surface so their behaviour cannot drift. Argo CD
 * returns the manifest as single-line JSON; it is re-serialised as YAML, and
 * anything that does not parse is shown untouched rather than discarded.
 */
export function ResourceManifestModal({ node, onboardingId, targetId, onClose, onDelete }: Props) {
  const [manifest, setManifest] = useState('')
  const [manifestError, setManifestError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const controller = new AbortController()
    setManifest('')
    setManifestError('')
    setLoading(true)
    void getResourceManifest(onboardingId, targetId, toRef(node), controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setManifest(formatResourceManifest(next))
      })
      .catch((error) => {
        if (!isAbortError(error))
          setManifestError(errorMessage(error, 'The manifest is unavailable'))
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
      size="lg"
      className="resource-modal"
      describedBy={false}
    >
      <DialogHeader
        className="resource-modal-header"
        icon={<KubernetesResourceIcon kind={node.kind} />}
        kicker={`${node.kind} YAML`}
        title={node.name}
        titleClassName="mono truncate"
        titleTooltip={node.name}
        closeLabel="Close YAML"
      />

      <div className="resource-modal-meta">
        <Tag mono>{node.group ? `${node.group}/${node.version}` : node.version}</Tag>
        <Tag mono>{node.namespace || 'cluster-scoped'}</Tag>
        {node.healthStatus && node.healthStatus !== 'Unknown' && (
          <StatusBadge domain="health" status={node.healthStatus} />
        )}
        {node.syncStatus && <Tag>{node.syncStatus}</Tag>}
      </div>

      <div className="resource-modal-body">
        {loading ? (
          <div className="code-pane-state" role="status">
            <span className="sr-only">Loading live YAML…</span>
            <Skeleton height={12} width="40%" />
            <Skeleton height={12} width="65%" />
            <Skeleton height={12} width="55%" />
          </div>
        ) : manifestError ? (
          <div className="code-pane-state code-pane-state--error" role="alert">
            {manifestError}
          </div>
        ) : (
          <pre className="code-pane" aria-label={`YAML for ${node.name}`}>
            {manifest}
          </pre>
        )}
      </div>

      <DialogFooter>
        <Button
          variant="danger"
          iconOnly
          className="resource-modal-delete"
          onClick={onDelete}
          aria-label="Delete resource"
          title="Delete resource"
        >
          <DeleteIcon />
        </Button>
        <DialogClose asChild>
          <Button>Close</Button>
        </DialogClose>
      </DialogFooter>
    </Dialog>
  )
}
