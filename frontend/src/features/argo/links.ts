import { isCommitSha } from './operation-phases'

/** A GitHub link to a values-repository commit, when the SHA is one. */
export function valuesCommitUrl(repositoryUrl: string, sha: string) {
  const base = repositoryUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
  if (!base || !isCommitSha(sha)) return null
  return `${base}/commit/${sha}`
}
