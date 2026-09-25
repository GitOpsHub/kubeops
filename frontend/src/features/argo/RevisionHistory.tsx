import { useCallback, useMemo, useState } from 'react'
import { getValuesRevisions, type ArgoAppStatus, type ValuesRevision } from '../../api/argo'
import { ApiError } from '../../api/client'
import type { ApplicationOnboarding } from '../../api/onboarding'
import { CommitIcon, InfoIcon, RetryIcon } from '../../components/icons'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { ErrorState } from '../../components/ui/ErrorState'
import { LoadingState } from '../../components/ui/LoadingState'
import { Timestamp } from '../../components/ui/Timestamp'
import { usePolledResource } from '../../hooks/usePolledResource'
import { shortSha } from './operation-phases'
import { deploysByCommit } from './revision-history'
import { RollbackDialog } from './RollbackDialog'
import { ValuesDiff } from './ValuesDiff'
import './argo.css'

type Props = {
  record: ApplicationOnboarding
  statuses: Record<string, ArgoAppStatus | undefined>
  consoleMutations: boolean
  onRolledBack: (next: ApplicationOnboarding) => void
}

/**
 * The release's values file through Git history, with each cluster's Argo CD
 * deploys pinned to the commit they shipped. Rolling back is a new commit, so
 * this list only ever grows.
 */
export function RevisionHistory({ record, statuses, consoleMutations, onRolledBack }: Props) {
  const load = useCallback(
    (signal: AbortSignal) => getValuesRevisions(record.id, 20, signal),
    [record.id],
  )
  const query = usePolledResource(load)
  const [diffOpen, setDiffOpen] = useState<string | null>(null)
  const [rollingBack, setRollingBack] = useState<ValuesRevision | null>(null)

  const commits = useMemo(() => query.data?.items ?? [], [query.data])
  const deploys = useMemo(
    () => deploysByCommit(commits, record.targets, statuses),
    [commits, record.targets, statuses],
  )

  if (query.loading) return <LoadingState label="Loading values history…" rows={4} />
  if (query.error && !query.data) {
    if (query.error instanceof ApiError && query.error.status === 422) {
      return (
        <EmptyState
          icon={<CommitIcon />}
          title="Values history is unavailable"
          description={`${query.error.message}. History and rollback need a GitHub values repository with a release-scoped values file.`}
        />
      )
    }
    return (
      <ErrorState
        title="Values history could not be loaded"
        message={query.error.message}
        onRetry={() => void query.reload()}
      />
    )
  }

  const list = query.data!
  const current = commits.find((commit) => commit.current) ?? commits[0]
  const offboarded = record.status === 'offboarded'
  const canRollBack = consoleMutations && !offboarded

  if (commits.length === 0) {
    return (
      <EmptyState
        icon={<CommitIcon />}
        title="No commits to this values file yet"
        description={`${list.path} has no history on ${list.branch}.`}
      />
    )
  }

  return (
    <div className="revisions">
      <header className="revisions-head">
        <div>
          <h3 className="revisions-title">
            <span className="mono">{list.path}</span> on <span className="mono">{list.branch}</span>
          </h3>
          <p className="subtle">
            Newest first. Badges show which commit each cluster's latest Argo CD deploy shipped.
          </p>
        </div>
        <Button size="sm" variant="ghost" icon={<RetryIcon />} onClick={() => void query.reload()}>
          Refresh
        </Button>
      </header>
      {!canRollBack && (
        <p className="revisions-note" role="note">
          <InfoIcon aria-hidden="true" />
          {offboarded
            ? 'This release is offboarded, so there is nothing to roll back.'
            : 'Rollback is turned off on this KubeOps server (ONBOARDING_CONSOLE_MUTATIONS=false). History and diffs stay available.'}
        </p>
      )}
      <ol className="revision-list" aria-label="Values revisions">
        {commits.map((commit) => {
          const onCommit = deploys.get(commit.sha) ?? []
          const live = onCommit.filter((deploy) => deploy.live)
          const earlier = onCommit.filter((deploy) => !deploy.live)
          const isCurrent = commit.sha === current?.sha
          const showingDiff = diffOpen === commit.sha
          return (
            <li
              key={commit.sha}
              className={`revision${isCurrent ? ' is-current' : ''}${live.length > 0 ? ' is-live' : ''}`}
            >
              <span className="revision-marker" aria-hidden="true" />
              <div className="revision-body">
                <div className="revision-headline">
                  <strong className="revision-message">{commit.message}</strong>
                  {isCurrent && (
                    <span className="revision-badge" data-tone="accent">
                      Current
                    </span>
                  )}
                  {live.map((deploy) => (
                    <span key={deploy.targetId} className="revision-badge" data-tone="ok">
                      Live on {deploy.clusterName}
                    </span>
                  ))}
                  {earlier.map((deploy) => (
                    <span key={deploy.targetId} className="revision-badge" data-tone="idle">
                      Was on {deploy.clusterName}
                    </span>
                  ))}
                </div>
                <div className="revision-meta">
                  <a className="mono" href={commit.url} target="_blank" rel="noreferrer">
                    {shortSha(commit.sha)}
                  </a>
                  <span>{commit.author || 'Unknown author'}</span>
                  <Timestamp value={commit.committedAt} fallback="—" />
                </div>
                {showingDiff && current && (
                  <ValuesDiff
                    onboardingId={record.id}
                    fromSha={commit.sha}
                    toSha={current.sha}
                    toLabel={`Current (${shortSha(current.sha)})`}
                    label={`Values diff from ${shortSha(commit.sha)} to the current commit`}
                  />
                )}
              </div>
              {!isCurrent && current && (
                <div className="revision-actions">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-expanded={showingDiff}
                    aria-label={`${showingDiff ? 'Hide' : 'View'} diff for ${shortSha(commit.sha)}`}
                    onClick={() => setDiffOpen(showingDiff ? null : commit.sha)}
                  >
                    {showingDiff ? 'Hide diff' : 'View diff'}
                  </Button>
                  {canRollBack && (
                    <Button
                      size="sm"
                      aria-label={`Roll back to ${shortSha(commit.sha)}`}
                      onClick={() => setRollingBack(commit)}
                    >
                      Roll back to this
                    </Button>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ol>

      {rollingBack && current && (
        <RollbackDialog
          record={record}
          commit={rollingBack}
          current={current}
          path={list.path}
          branch={list.branch}
          onClose={() => setRollingBack(null)}
          onRolledBack={(next) => {
            onRolledBack(next)
            void query.reload()
          }}
        />
      )}
    </div>
  )
}
