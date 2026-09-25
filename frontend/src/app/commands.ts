import { getSources, queueSourceSync } from '../api/inventory'
import { errorMessage } from '../api/client'
import type { IconComponent } from '../components/icons'

/**
 * What the command palette offers and how it ranks it, kept apart from the
 * palette component so the matching rules can change without touching focus
 * or keyboard handling.
 */

export type CommandGroupId = 'navigate' | 'actions' | 'applications' | 'clusters'

export const commandGroups: { id: CommandGroupId; label: string }[] = [
  { id: 'navigate', label: 'Navigate' },
  { id: 'actions', label: 'Actions' },
  { id: 'applications', label: 'Applications' },
  { id: 'clusters', label: 'Clusters' },
]

export type Command = {
  id: string
  group: CommandGroupId
  label: string
  /** A short second line, e.g. a cluster's provider and region. */
  detail?: string
  keywords?: string[]
  icon?: IconComponent
  /**
   * Already filtered by the server, whose search may match fields the palette
   * does not see. Such a command is kept even when its label does not match.
   */
  serverMatched?: boolean
  perform: () => void
}

function isSubsequence(needle: string, haystack: string) {
  let index = 0
  for (const char of haystack) {
    if (char === needle[index]) index += 1
    if (index === needle.length) return true
  }
  return false
}

/** Lower is better; `null` means the command does not match at all. */
export function commandScore(command: Command, query: string): number | null {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return 0
  const label = command.label.toLocaleLowerCase()
  if (label.startsWith(needle)) return 0
  if (label.split(/[\s/._-]+/).some((word) => word.startsWith(needle))) return 1
  if (label.includes(needle)) return 2
  const keywords = (command.keywords ?? []).map((keyword) => keyword.toLocaleLowerCase())
  if (keywords.some((keyword) => keyword.startsWith(needle))) return 3
  if (keywords.some((keyword) => keyword.includes(needle))) return 4
  // Abbreviations such as "cls" for Cloud sources.
  if (needle.length > 1 && isSubsequence(needle, label)) return 5
  return command.serverMatched ? 6 : null
}

export type CommandSection = { id: CommandGroupId; label: string; commands: Command[] }

/**
 * The matching commands, grouped in a fixed order and ranked within each
 * group. Groups never reorder by score: a stable layout is what lets people
 * build muscle memory ("Navigate is always first").
 */
export function filterCommands(commands: Command[], query: string): CommandSection[] {
  return commandGroups
    .map((group) => ({
      ...group,
      commands: commands
        .map((command, index) => ({ command, index, score: commandScore(command, query) }))
        .filter(
          (entry): entry is { command: Command; index: number; score: number } =>
            entry.command.group === group.id && entry.score !== null,
        )
        .sort((left, right) => left.score - right.score || left.index - right.index)
        .map((entry) => entry.command),
    }))
    .filter((group) => group.commands.length > 0)
}

export type SyncAllResult = {
  queued: number
  failed: { name: string; message: string }[]
}

/**
 * Queues a discovery sync for every enabled source — the same request as each
 * source's "Sync now" button, sent once per source. A source that is already
 * syncing answers 409, which is reported rather than treated as fatal.
 */
export async function queueAllSourceSyncs(): Promise<SyncAllResult> {
  const sources = (await getSources()).filter((source) => source.enabled)
  const results = await Promise.allSettled(sources.map((source) => queueSourceSync(source.id)))
  const failed = results.flatMap((result, index) =>
    result.status === 'rejected'
      ? [{ name: sources[index].name, message: errorMessage(result.reason, 'Sync failed') }]
      : [],
  )
  return { queued: results.length - failed.length, failed }
}
