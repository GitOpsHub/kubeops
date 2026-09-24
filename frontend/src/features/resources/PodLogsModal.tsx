import { useEffect, useRef, useState } from 'react'
import { errorMessage, isAbortError } from '../../api/client'
import { streamPodLogs, type ResourceNode } from '../../api/onboarding'
import { Button } from '../../components/ui/Button'
import { Dialog, DialogClose, DialogTitle } from '../../components/ui/Dialog'
import { toRef } from './resource-ref'

type Props = {
  node: ResourceNode
  onboardingId: string
  targetId: string
  onClose: () => void
}

type StreamState = 'connecting' | 'live' | 'ended' | 'error'

const stateLabels: Record<StreamState, string> = {
  connecting: 'Connecting',
  live: 'Live',
  ended: 'Ended',
  error: 'Error',
}

/** Keeps the stream bounded: an hour of chatty logs would otherwise grow without limit. */
const maxLines = 2000

export function PodLogsModal({ node, onboardingId, targetId, onClose }: Props) {
  const [lines, setLines] = useState<string[]>([])
  const [state, setState] = useState<StreamState>('connecting')
  const [error, setError] = useState('')
  const outputRef = useRef<HTMLPreElement | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void streamPodLogs(
      onboardingId,
      targetId,
      toRef(node),
      (entry) => {
        const prefix = entry.timestamp ? `${entry.timestamp} ` : ''
        setLines((current) => [...current, `${prefix}${entry.content ?? ''}`].slice(-maxLines))
        setState('live')
      },
      controller.signal,
    )
      .then(() => {
        if (!controller.signal.aborted) setState('ended')
      })
      .catch((streamError) => {
        if (isAbortError(streamError)) return
        setError(errorMessage(streamError, 'Pod logs are unavailable'))
        setState('error')
      })
    return () => controller.abort()
  }, [node, onboardingId, targetId])

  // Follow the tail as lines arrive.
  useEffect(() => {
    const output = outputRef.current
    if (output) output.scrollTop = output.scrollHeight
  }, [lines])

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      size="xl"
      className="pod-logs-modal"
      describedBy={false}
    >
      <header className="dialog-header">
        <div className="dialog-title-group">
          <p className="kicker">Pod log stream</p>
          <DialogTitle asChild>
            <h2 className="mono truncate" title={node.name}>
              {node.name}
            </h2>
          </DialogTitle>
          <span className="subtle mono">{node.namespace || 'default'}</span>
        </div>
        <span className={`pod-logs-state pod-logs-state--${state}`}>
          <i aria-hidden="true" />
          {stateLabels[state]}
        </span>
      </header>

      <div className="pod-logs-output-wrap">
        {state === 'connecting' && lines.length === 0 && (
          <div className="pod-logs-overlay" role="status">
            Connecting to the Pod…
          </div>
        )}
        {state === 'error' && (
          <div className="pod-logs-overlay pod-logs-overlay--error" role="alert">
            {error}
          </div>
        )}
        <pre ref={outputRef} className="pod-logs-output" aria-label={`Live logs for ${node.name}`}>
          {lines.join('\n')}
        </pre>
      </div>

      <footer className="dialog-footer">
        <span className="dialog-footer-note">
          Showing the latest {lines.length.toLocaleString()} lines
        </span>
        <Button variant="ghost" onClick={() => setLines([])}>
          Clear
        </Button>
        <DialogClose asChild>
          <Button variant="primary">Close</Button>
        </DialogClose>
      </footer>
    </Dialog>
  )
}
