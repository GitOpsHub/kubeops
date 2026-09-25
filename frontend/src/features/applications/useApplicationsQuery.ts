import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { getSources } from '../../api/inventory'
import {
  getAllApplicationOnboardings,
  onboardingStatuses,
  type OnboardingStatus,
} from '../../api/onboarding'
import { usePolledResource } from '../../hooks/usePolledResource'
import {
  compareEnvironments,
  compareGroups,
  groupApplications,
  isSortKey,
  isStatus,
  matchesSearch,
  type SortDirection,
  type SortKey,
} from './application-groups'

// Nothing on this list moves faster than an Argo sync; the detail page is
// where a single release is watched closely.
const pollIntervalMs = 20_000
const searchDebounceMs = 250
export const pageSizeOptions = [25, 50, 100]
const defaultPageSize = 50

/**
 * Everything the applications list derives: the URL-backed filters, the
 * polled releases, and the grouped, filtered, sorted, paged view of them.
 *
 * Filters live in the URL so a filtered list stays bookmarkable. Only the
 * "offboarded" status reaches the API (offboarded releases are excluded
 * server-side unless asked for); every other filter is applied after
 * grouping, since filtering releases would hide part of an application and
 * leave the row claiming a status it does not have.
 */
export function useApplicationsQuery() {
  const [searchParams, setSearchParams] = useSearchParams()

  const search = searchParams.get('search') ?? ''
  const statusParam = searchParams.get('status') ?? ''
  const status: OnboardingStatus | '' = isStatus(statusParam) ? statusParam : ''
  const environment = searchParams.get('environment') ?? ''
  const sortParam = searchParams.get('sort') ?? ''
  const sortKey: SortKey = isSortKey(sortParam) ? sortParam : 'name'
  const sortDirection: SortDirection = searchParams.get('dir') === 'desc' ? 'desc' : 'asc'
  const page = Math.max(1, Number(searchParams.get('page')) || 1)
  const pageSizeParam = Number(searchParams.get('pageSize'))
  const pageSize = pageSizeOptions.includes(pageSizeParam) ? pageSizeParam : defaultPageSize

  const [searchDraft, setSearchDraft] = useState(search)

  const updateParams = useCallback(
    (changes: Record<string, string>, resetPage = true) => {
      const next = new URLSearchParams(searchParams)
      for (const [key, value] of Object.entries(changes)) {
        if (value) next.set(key, value)
        else next.delete(key)
      }
      if (resetPage) next.delete('page')
      setSearchParams(next, { replace: true })
    },
    [searchParams, setSearchParams],
  )

  const includeOffboarded = status === 'offboarded'
  const load = useCallback(
    (signal: AbortSignal) => getAllApplicationOnboardings({ includeOffboarded }, signal),
    [includeOffboarded],
  )
  const query = usePolledResource(load, { intervalMs: pollIntervalMs })
  const items = useMemo(() => query.data ?? [], [query.data])

  // Sources turn the platform IDs on each target into names and logos. They
  // change rarely, so one load is enough, and a failure leaves the raw IDs.
  const sourcesQuery = usePolledResource(getSources)
  const sources = useMemo(
    () => new Map((sourcesQuery.data ?? []).map((source) => [source.id, source])),
    [sourcesQuery.data],
  )

  // Typing filters a list already in memory, but it still re-renders every
  // row; the pause keeps a 100-row table responsive and the URL out of the way.
  useEffect(() => {
    if (searchDraft === search) return
    const timer = window.setTimeout(() => updateParams({ search: searchDraft }), searchDebounceMs)
    return () => window.clearTimeout(timer)
  }, [search, searchDraft, updateParams])

  const groups = useMemo(() => groupApplications(items), [items])

  const environmentOptions = useMemo(
    () => [...new Set(groups.flatMap((group) => group.environments))].sort(compareEnvironments),
    [groups],
  )

  // Status counts describe the set being looked at, minus the status filter
  // itself — otherwise picking one collapses every other count to zero.
  const scopedGroups = useMemo(
    () =>
      groups.filter(
        (group) =>
          matchesSearch(group, search) &&
          (!environment || group.environments.includes(environment)),
      ),
    [groups, search, environment],
  )

  // Every live status keeps its place in the summary, even at zero, so the
  // strip does not reflow as releases move; offboarded appears only once
  // asked for, since the list excludes it by default.
  const statusCounts = useMemo(() => {
    const counts = new Map<OnboardingStatus, number>()
    for (const group of scopedGroups) counts.set(group.status, (counts.get(group.status) ?? 0) + 1)
    return onboardingStatuses
      .map((item) => ({ status: item, count: counts.get(item) ?? 0 }))
      .filter(
        (entry) => entry.status !== 'offboarded' || entry.count > 0 || status === entry.status,
      )
  }, [scopedGroups, status])

  const filteredGroups = useMemo(() => {
    const matched = status ? scopedGroups.filter((group) => group.status === status) : scopedGroups
    const direction = sortDirection === 'desc' ? -1 : 1
    return [...matched].sort((left, right) => compareGroups(left, right, sortKey) * direction)
  }, [scopedGroups, status, sortKey, sortDirection])

  const totalPages = Math.max(1, Math.ceil(filteredGroups.length / pageSize))
  const firstIndex = (page - 1) * pageSize
  const visibleGroups = filteredGroups.slice(firstIndex, firstIndex + pageSize)

  // A bookmarked page past the end snaps back to the last real page.
  useEffect(() => {
    if (query.loading || page <= totalPages) return
    const next = new URLSearchParams(searchParams)
    next.set('page', String(totalPages))
    setSearchParams(next, { replace: true })
  }, [query.loading, page, searchParams, setSearchParams, totalPages])

  function toggleSort(key: SortKey) {
    if (key === sortKey) updateParams({ sort: key, dir: sortDirection === 'asc' ? 'desc' : 'asc' })
    else updateParams({ sort: key, dir: 'asc' })
  }

  function clearSearch() {
    setSearchDraft('')
    updateParams({ search: '' })
  }

  function clearAllFilters() {
    setSearchDraft('')
    updateParams({ search: '', status: '', environment: '' })
  }

  return {
    query,
    items,
    filters: { search, searchDraft, status, environment, sortKey, sortDirection, page, pageSize },
    setSearchDraft,
    updateParams,
    toggleSort,
    clearSearch,
    clearAllFilters,
    environmentOptions,
    statusCounts,
    scopedTotal: scopedGroups.length,
    sources,
    filteredGroups,
    visibleGroups,
    hasFilters: Boolean(search || status || environment),
  }
}

export type ApplicationsQuery = ReturnType<typeof useApplicationsQuery>
