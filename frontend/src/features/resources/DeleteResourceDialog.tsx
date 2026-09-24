import type { ResourceNode } from '../../api/onboarding'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'

type Props = {
  node: ResourceNode | null
  clusterName: string
  deleting: boolean
  onCancel: () => void
  onConfirm: () => void
}

const dataBearingKinds = new Set(['Namespace', 'PersistentVolumeClaim'])

export function DeleteResourceDialog({ node, clusterName, deleting, onCancel, onConfirm }: Props) {
  return (
    <ConfirmDialog
      open={node !== null}
      onOpenChange={(next) => !next && onCancel()}
      danger
      kicker="Confirm deletion"
      title={node ? `Delete ${node.kind} ${node.name}?` : ''}
      description={
        <>
          This removes the live object from <strong>{clusterName}</strong>. It does not change Git,
          so Argo CD recreates it on the next sync if the application still declares it.
        </>
      }
      // Names the kind so it is never confused with the button that opened
      // this dialog.
      confirmLabel={node ? `Delete ${node.kind}` : 'Delete'}
      submittingLabel="Deleting…"
      submitting={deleting}
      onConfirm={onConfirm}
    >
      {node && dataBearingKinds.has(node.kind) && (
        <p className="dialog-warning">
          Deleting a {node.kind} can destroy data that is not recoverable by a sync.
        </p>
      )}
    </ConfirmDialog>
  )
}
