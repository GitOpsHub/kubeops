import { Link } from 'react-router-dom'
import type { LogResourceRef } from '../../api/argo'
import { KubernetesResourceIcon } from '../../components/KubernetesResourceIcon'
import { ExternalLinkIcon } from '../../components/icons'
import { buttonClass } from '../../components/ui/button-class'
import { Sheet } from '../../components/ui/Sheet'
import { LogViewer } from './LogViewer'
import { logsPageHref } from './logs-link'
import './log-viewer.css'

type Props = {
  onboardingId: string
  targetId: string
  /** Shown under the title so the reader knows which cluster this is. */
  clusterName?: string
  resource: LogResourceRef
  onClose: () => void
}

/** The log viewer beside the resource it was opened from. */
export function LogsSheet({ onboardingId, targetId, clusterName, resource, onClose }: Props) {
  return (
    <Sheet
      open
      onOpenChange={(next) => !next && onClose()}
      size="xl"
      className="logs-sheet"
      kicker={`${resource.kind} logs`}
      title={<span className="mono">{resource.name}</span>}
      icon={<KubernetesResourceIcon kind={resource.kind} />}
      description={[resource.namespace || 'default', clusterName].filter(Boolean).join(' · ')}
      actions={
        <Link
          className={buttonClass('ghost', 'sm')}
          to={logsPageHref(onboardingId, targetId, resource)}
        >
          <ExternalLinkIcon aria-hidden="true" />
          Open full screen
        </Link>
      }
    >
      <LogViewer
        onboardingId={onboardingId}
        targetId={targetId}
        resource={resource}
        className="logs-sheet-viewer"
      />
    </Sheet>
  )
}
