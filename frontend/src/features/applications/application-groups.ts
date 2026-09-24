import {
  onboardingStatuses,
  type ApplicationDeployment,
  type ApplicationOnboarding,
  type OnboardingStatus,
} from '../../api/onboarding'

/**
 * An "application" in the UI is every onboarding that shares a name: one per
 * environment and region. The API returns releases, so the list, the tiles,
 * and the overview all group them here the same way.
 */

export const environmentOrder = ['dev', 'qa', 'prod']

export type SortKey = 'name' | 'targets' | 'status'
export type SortDirection = 'asc' | 'desc'

export const sortLabels: Record<SortKey, string> = {
  name: 'Name',
  targets: 'Releases',
  status: 'Status',
}

// Worst first: the reason to sort by status is to find what is broken.
export const statusSeverity: Record<OnboardingStatus, number> = {
  failed: 0,
  partial: 1,
  progressing: 2,
  healthy: 3,
  offboarded: 4,
}

export function isStatus(value: string): value is OnboardingStatus {
  return (onboardingStatuses as string[]).includes(value)
}

export function isSortKey(value: string): value is SortKey {
  return value === 'name' || value === 'targets' || value === 'status'
}

export function groupStatus(records: ApplicationOnboarding[]): OnboardingStatus {
  const statuses = new Set(records.map((record) => record.status))
  if (statuses.size === 1) return records[0].status
  if (statuses.has('failed') || statuses.has('partial')) return 'partial'
  if (statuses.has('progressing')) return 'progressing'
  if (statuses.has('healthy')) return 'partial'
  return 'offboarded'
}

function uniqueSorted(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right))
}

export function compareEnvironments(left: string, right: string) {
  const leftIndex = environmentOrder.indexOf(left)
  const rightIndex = environmentOrder.indexOf(right)
  if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right)
  if (leftIndex === -1) return 1
  if (rightIndex === -1) return -1
  return leftIndex - rightIndex
}

export type TargetRow = {
  key: string
  releaseId: string
  environment: string
  region: string
  namespace: string
  target: ApplicationDeployment | null
}

/**
 * The expanded row answers one question — where does this run and is it well —
 * so every target is one line, ordered the way an operator promotes: dev first,
 * then region, then cluster. Releases without targets still get a line so a
 * half-finished onboarding is visible rather than absent.
 */
export function flattenTargets(records: ApplicationOnboarding[]): TargetRow[] {
  const rows: TargetRow[] = []
  for (const record of records) {
    if (record.targets.length === 0) {
      rows.push({
        key: record.id,
        releaseId: record.id,
        environment: record.environment,
        region: record.region,
        namespace: record.namespace,
        target: null,
      })
      continue
    }
    for (const target of record.targets) {
      rows.push({
        key: target.id,
        releaseId: record.id,
        environment: record.environment,
        region: target.region || record.region,
        namespace: record.namespace,
        target,
      })
    }
  }
  return rows.sort(
    (left, right) =>
      compareEnvironments(left.environment, right.environment) ||
      left.region.localeCompare(right.region) ||
      (left.target?.clusterName ?? '').localeCompare(right.target?.clusterName ?? ''),
  )
}

export function groupApplications(records: ApplicationOnboarding[]) {
  const groups = new Map<string, ApplicationOnboarding[]>()
  for (const record of records) {
    const key = record.name.trim().toLocaleLowerCase()
    const current = groups.get(key)
    if (current) current.push(record)
    else groups.set(key, [record])
  }

  return [...groups.entries()].map(([key, groupedRecords]) => {
    const recordsByScope = [...groupedRecords].sort(
      (left, right) =>
        compareEnvironments(left.environment, right.environment) ||
        left.region.localeCompare(right.region),
    )
    const targets = recordsByScope.flatMap((record) => record.targets)
    const identityRecord = [...recordsByScope].sort(
      (left, right) =>
        new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime() ||
        left.id.localeCompare(right.id),
    )[0]
    return {
      key,
      name: recordsByScope[0].name,
      // The first persisted onboarding ID anchors the logical group, so adding
      // another regional release later does not renumber the application. It is
      // also the ID every link on the row opens, so what is shown and what is
      // opened cannot drift apart.
      applicationId: identityRecord.id,
      records: recordsByScope,
      targets,
      namespaces: uniqueSorted(recordsByScope.map((record) => record.namespace)),
      // Promotion order, not alphabetical: "dev qa prod" is how the row is read.
      environments: [...new Set(recordsByScope.map((record) => record.environment))]
        .filter(Boolean)
        .sort(compareEnvironments),
      regions: uniqueSorted(recordsByScope.map((record) => record.region)),
      platformIds: uniqueSorted(targets.map((target) => target.sourceId)),
      status: groupStatus(recordsByScope),
    }
  })
}

export type ApplicationGroup = ReturnType<typeof groupApplications>[number]

export function matchesSearch(group: ApplicationGroup, term: string) {
  const needle = term.trim().toLocaleLowerCase()
  if (!needle) return true
  return (
    group.name.toLocaleLowerCase().includes(needle) ||
    group.namespaces.some((namespace) => namespace.toLocaleLowerCase().includes(needle))
  )
}

export function compareGroups(left: ApplicationGroup, right: ApplicationGroup, key: SortKey) {
  if (key === 'targets') {
    return left.targets.length - right.targets.length || left.name.localeCompare(right.name)
  }
  if (key === 'status') {
    return (
      statusSeverity[left.status] - statusSeverity[right.status] ||
      left.name.localeCompare(right.name)
    )
  }
  return left.name.localeCompare(right.name)
}

export function namespaceLabel(group: ApplicationGroup) {
  return group.namespaces.length === 1
    ? group.namespaces[0]
    : `${group.namespaces.length} namespaces`
}
