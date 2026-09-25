import type { SyncOptions } from '../../api/argo'

function list(names: string[]) {
  if (names.length <= 1) return names[0] ?? ''
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`
}

/**
 * The sync the dialog is about to request, in one plain paragraph, so the
 * options read as consequences rather than as flags.
 */
export function describeSync(options: SyncOptions, clusterNames: string[], branch: string) {
  const where = list(clusterNames)
  if (clusterNames.length === 0) return 'Choose at least one cluster to sync.'
  const ref = branch ? `the latest commit on ${branch}` : 'the latest Git revision'
  const sentences = options.dryRun
    ? [`Preview a sync of ${where} against ${ref}. Nothing on the cluster changes.`]
    : [`Apply ${ref} to ${where}.`]
  sentences.push(
    options.prune
      ? 'Resources removed from Git are deleted.'
      : 'Resources removed from Git are left in place, unless the automated sync policy prunes them.',
  )
  if (options.applyOutOfSyncOnly) sentences.push('Only resources that are out of sync are applied.')
  if (options.force) sentences.push('Resources that cannot be patched are deleted and recreated.')
  return sentences.join(' ')
}
