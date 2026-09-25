import { buildManifestDiff } from '../../lib/resource-diff'

export type UnifiedLine =
  | { kind: 'same' | 'removed' | 'added'; text: string; oldLine?: number; newLine?: number }
  | { kind: 'gap'; count: number }

/** Unchanged lines kept around each change; longer runs fold into a gap. */
const context = 3

/**
 * A unified (+/-) diff of two values files. Side by side needs a wide screen;
 * a values file changes a line or two at a time, which reads better stacked,
 * with long unchanged stretches folded away.
 */
export function unifiedValuesDiff(before: string, after: string): UnifiedLine[] {
  const lines: Exclude<UnifiedLine, { kind: 'gap' }>[] = []
  for (const row of buildManifestDiff(before.trimEnd(), after.trimEnd())) {
    if (row.tone === 'same') {
      lines.push({
        kind: 'same',
        text: row.leftText ?? '',
        oldLine: row.leftLine,
        newLine: row.rightLine,
      })
      continue
    }
    if (row.leftText !== undefined) {
      lines.push({ kind: 'removed', text: row.leftText, oldLine: row.leftLine })
    }
    if (row.rightText !== undefined) {
      lines.push({ kind: 'added', text: row.rightText, newLine: row.rightLine })
    }
  }

  const changed = lines.map((line) => line.kind !== 'same')
  const keep = lines.map((_, index) => {
    for (let offset = -context; offset <= context; offset++) {
      if (changed[index + offset]) return true
    }
    return false
  })

  const result: UnifiedLine[] = []
  let folded = 0
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (folded > 0) result.push({ kind: 'gap', count: folded })
      folded = 0
      result.push(line)
    } else {
      folded += 1
    }
  })
  if (folded > 0 && result.length > 0) result.push({ kind: 'gap', count: folded })
  return result
}

export function diffStats(lines: UnifiedLine[]) {
  return {
    added: lines.filter((line) => line.kind === 'added').length,
    removed: lines.filter((line) => line.kind === 'removed').length,
  }
}
