import type { ArgoAppStatus, ValuesRevision } from '../../api/argo'
import type { ApplicationDeployment } from '../../api/onboarding'
import { valuesRevisionOf } from './operation-phases'

/**
 * Which values-file commit each cluster is running.
 *
 * Argo CD records the values repository's HEAD at deploy time, and HEAD may be
 * a commit that never touched this release's file (another release's scale,
 * say). An exact match is trusted; otherwise the file as deployed is the
 * newest commit to it at or before the deploy.
 */

function sameSha(left: string, right: string) {
  const a = left.toLowerCase()
  const b = right.toLowerCase()
  return Math.min(a.length, b.length) >= 7 && (a.startsWith(b) || b.startsWith(a))
}

function time(value: string | null | undefined) {
  const parsed = value ? Date.parse(value) : Number.NaN
  return Number.isNaN(parsed) ? null : parsed
}

/** The commit (from `commits`, newest first) a deploy of `sha` at `at` shipped. */
export function commitForDeploy(commits: ValuesRevision[], sha: string, at: string | null) {
  if (sha) {
    const exact = commits.find((commit) => sameSha(commit.sha, sha))
    if (exact) return exact
  }
  const deployedAt = time(at)
  if (deployedAt === null) return null
  return (
    commits.find((commit) => {
      const committedAt = time(commit.committedAt)
      return committedAt !== null && committedAt <= deployedAt
    }) ?? null
  )
}

export type CommitDeploy = {
  targetId: string
  clusterName: string
  at: string | null
  /** The deploy each cluster is running now, as opposed to an earlier one. */
  live: boolean
  automated: boolean
}

/** Deploys keyed by the commit SHA they shipped, newest deploy first. */
export function deploysByCommit(
  commits: ValuesRevision[],
  targets: ApplicationDeployment[],
  statuses: Record<string, ArgoAppStatus | undefined>,
) {
  const result = new Map<string, CommitDeploy[]>()
  const add = (sha: string, deploy: CommitDeploy) => {
    const list = result.get(sha) ?? []
    // One badge per cluster per commit: repeated syncs of the same file read
    // as the newest one.
    if (!list.some((item) => item.targetId === deploy.targetId)) list.push(deploy)
    else if (deploy.live) {
      const index = list.findIndex((item) => item.targetId === deploy.targetId)
      list[index] = deploy
    }
    result.set(sha, list)
  }

  for (const target of targets) {
    const status = statuses[target.id]
    if (!status) continue
    const history = status.history
    history.forEach((entry, index) => {
      const commit = commitForDeploy(
        commits,
        valuesRevisionOf(entry.revisions),
        entry.deployedAt ?? entry.deployStartedAt,
      )
      if (!commit) return
      add(commit.sha, {
        targetId: target.id,
        clusterName: target.clusterName,
        at: entry.deployedAt ?? entry.deployStartedAt,
        live: index === 0,
        automated: entry.initiatedBy.automated,
      })
    })
    // A cluster with no recorded history is still running something: what it
    // is synced to right now.
    if (history.length === 0 && status.sync.status.toLowerCase() === 'synced') {
      const commit = commitForDeploy(
        commits,
        valuesRevisionOf(status.sync.revisions),
        status.reconciledAt,
      )
      if (commit) {
        add(commit.sha, {
          targetId: target.id,
          clusterName: target.clusterName,
          at: status.reconciledAt,
          live: true,
          automated: false,
        })
      }
    }
  }
  return result
}
