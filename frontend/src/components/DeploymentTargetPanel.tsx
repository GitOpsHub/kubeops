import { useState } from 'react'
import { getClusterArgoAccess } from '../api/inventory'
import type { ApplicationDeployment } from '../api/onboarding'

type Props = {
  target: ApplicationDeployment
}

/**
 * Renders one Argo CD deployment target. The Argo CD password is fetched only when
 * the operator asks for it and is written straight to the clipboard, so it is never
 * rendered or held in component state.
 */
export function DeploymentTargetPanel({ target }: Props) {
  const [copying, setCopying] = useState(false)
  const [message, setMessage] = useState('')

  async function copyPassword() {
    setCopying(true)
    setMessage('')
    try {
      const access = await getClusterArgoAccess(target.clusterId)
      await navigator.clipboard.writeText(access.password)
      setMessage('Password copied to the clipboard.')
    } catch (copyError) {
      setMessage(
        copyError instanceof Error ? copyError.message : 'Password could not be copied.',
      )
    } finally {
      setCopying(false)
    }
  }

  return (
    <article className="target-panel" aria-label={`Deployment target ${target.clusterName}`}>
      <header>
        <div>
          <strong>{target.clusterName}</strong>
          <span>{target.region || 'no region'}</span>
        </div>
        <span className={`deployment-pill deployment-pill--${target.status}`}>
          {target.status}
        </span>
      </header>

      <dl className="target-facts">
        <div>
          <dt>Argo application</dt>
          <dd className="mono">{target.argoApplication}</dd>
        </div>
        <div>
          <dt>Sync status</dt>
          <dd>{target.syncStatus || 'Unknown'}</dd>
        </div>
        <div>
          <dt>Health</dt>
          <dd>{target.healthStatus || 'Unknown'}</dd>
        </div>
      </dl>

      {target.message && (
        <p className="target-message" role="status">
          {target.message}
        </p>
      )}

      {target.argoApplicationUrl ? (
        <div className="target-actions">
          <a href={target.argoApplicationUrl} target="_blank" rel="noreferrer">
            Open in Argo CD
          </a>
          {target.argoUsername && (
            <span className="target-username">
              Username <code>{target.argoUsername}</code>
            </span>
          )}
          <button type="button" disabled={copying} onClick={() => void copyPassword()}>
            {copying ? 'Copying…' : 'Copy password'}
          </button>
        </div>
      ) : (
        <p className="target-unavailable">
          Argo CD UI access is not configured for this cluster.
        </p>
      )}

      {message && (
        <p className="scale-message" role="status">
          {message}
        </p>
      )}
    </article>
  )
}
