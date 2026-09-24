import type { ResourceNode } from '../../api/onboarding'
import { Button } from '../../components/ui/Button'
import { Dialog, DialogDescription, DialogTitle } from '../../components/ui/Dialog'

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
    <Dialog
      open={node !== null}
      onOpenChange={(next) => !next && onCancel()}
      size="sm"
      alert
      dismissible={!deleting}
    >
      {node && (
        <>
          <header className="dialog-header">
            <div className="dialog-title-group">
              <p className="kicker">Confirm deletion</p>
              <DialogTitle asChild>
                <h3>
                  Delete {node.kind} {node.name}?
                </h3>
              </DialogTitle>
            </div>
          </header>
          <div className="dialog-body">
            <DialogDescription asChild>
              <p>
                This removes the live object from <strong>{clusterName}</strong>. It does not change
                Git, so Argo CD recreates it on the next sync if the application still declares it.
              </p>
            </DialogDescription>
            {dataBearingKinds.has(node.kind) && (
              <p className="dialog-warning">
                Deleting a {node.kind} can destroy data that is not recoverable by a sync.
              </p>
            )}
          </div>
          <footer className="dialog-footer">
            <Button disabled={deleting} onClick={onCancel}>
              Cancel
            </Button>
            {/* Names the kind so it is never confused with the button that
                opened this dialog. */}
            <Button variant="danger" loading={deleting} onClick={onConfirm}>
              {deleting ? 'Deleting…' : `Delete ${node.kind}`}
            </Button>
          </footer>
        </>
      )}
    </Dialog>
  )
}
