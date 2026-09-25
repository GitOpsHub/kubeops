import { useCallback } from 'react'
import { getRevisionValues } from '../../api/argo'
import { ErrorState } from '../../components/ui/ErrorState'
import { LoadingState } from '../../components/ui/LoadingState'
import { usePolledResource } from '../../hooks/usePolledResource'
import { shortSha } from './operation-phases'
import { diffStats, unifiedValuesDiff } from './values-diff'
import './argo.css'

type Props = {
  onboardingId: string
  fromSha: string
  toSha: string
  fromLabel?: string
  toLabel?: string
  /** Accessible name for the diff region. */
  label: string
}

/** The values file at two commits, as a unified diff. */
export function ValuesDiff({ onboardingId, fromSha, toSha, fromLabel, toLabel, label }: Props) {
  const load = useCallback(
    async (signal: AbortSignal) => {
      const [from, to] = await Promise.all([
        getRevisionValues(onboardingId, fromSha, signal),
        getRevisionValues(onboardingId, toSha, signal),
      ])
      return {
        lines: unifiedValuesDiff(from.valuesYaml, to.valuesYaml),
        hidden: hiddenValues(from.redactedKeys, to.redactedKeys),
      }
    },
    [onboardingId, fromSha, toSha],
  )
  const query = usePolledResource(load)

  if (query.loading) return <LoadingState label="Loading values…" shape="rows" rows={3} />
  if (query.error || !query.data) {
    return (
      <ErrorState
        compact
        title="The values diff could not be loaded"
        message={query.error?.message}
        onRetry={() => void query.reload()}
      />
    )
  }

  const { lines, hidden } = query.data
  const stats = diffStats(lines)
  return (
    <figure className="values-diff" aria-label={label}>
      <figcaption className="values-diff-head">
        <span className="mono">
          {fromLabel ?? shortSha(fromSha)} → {toLabel ?? shortSha(toSha)}
        </span>
        {stats.added + stats.removed === 0 ? (
          <span className="values-diff-same">No changes to the values file</span>
        ) : (
          <span className="tabular">
            <span className="values-diff-added">+{stats.added}</span>{' '}
            <span className="values-diff-removed">−{stats.removed}</span>
          </span>
        )}
        {hidden !== null && (
          <span className="values-diff-same" role="note">
            {hidden === 'all'
              ? 'Values that are not valid YAML are hidden'
              : `${hidden} secret-looking ${hidden === 1 ? 'value is' : 'values are'} hidden`}
          </span>
        )}
      </figcaption>
      {lines.length > 0 && (
        <pre className="values-diff-code">
          {lines.map((line, index) =>
            line.kind === 'gap' ? (
              <span key={index} className="values-diff-line values-diff-line--gap">
                ⋯ {line.count} unchanged {line.count === 1 ? 'line' : 'lines'}
              </span>
            ) : (
              <span key={index} className={`values-diff-line values-diff-line--${line.kind}`}>
                <span className="values-diff-sign" aria-hidden="true">
                  {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
                </span>
                {line.kind !== 'same' && (
                  <span className="sr-only">{line.kind === 'added' ? 'Added: ' : 'Removed: '}</span>
                )}
                {line.text || ' '}
              </span>
            ),
          )}
        </pre>
      )}
    </figure>
  )
}

/**
 * How many distinct values the server redacted across both commits — changes
 * to them cannot show in the diff — `all` when a file was withheld whole, or
 * null when nothing is hidden.
 */
function hiddenValues(from: string[], to: string[]): number | 'all' | null {
  const keys = new Set([...from, ...to])
  if (keys.has('*')) return 'all'
  return keys.size > 0 ? keys.size : null
}
