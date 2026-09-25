import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Cluster } from '../../api/inventory'
import { ProviderLogo } from '../../components/BrandIcons'
import { ClusterIcon, ErrorIcon, SearchIcon } from '../../components/icons'
import { StatusBadge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { buttonClass } from '../../components/ui/button-class'
import { EmptyState } from '../../components/ui/EmptyState'
import { ErrorState } from '../../components/ui/ErrorState'
import { Switch } from '../../components/ui/Field'
import { LoadingState } from '../../components/ui/LoadingState'
import { SearchInput } from '../../components/ui/SearchInput'
import { plural } from '../../lib/format'
import { providerLabels, providerNames, providers } from '../../lib/providers'
import { clusterInRegion, matchesSearch } from './onboarding-wizard'
import '../../components/ui/DataTable.css'

type Props = {
  clusters: Cluster[]
  loading: boolean
  loadError: string
  onRetry: () => void
  region: string
  selectedIds: string[]
  onSelectionChange: (ids: string[]) => void
  showAll: boolean
  onShowAllChange: (showAll: boolean) => void
  error?: string
}

export const targetsErrorId = 'onboarding-targets-error'

/**
 * Clusters in the chosen region, grouped by provider. Local clusters report a
 * location outside any cloud region, so "Show all clusters" is how they are
 * reached — never by silently widening the default list.
 */
export function TargetPicker({
  clusters,
  loading,
  loadError,
  onRetry,
  region,
  selectedIds,
  onSelectionChange,
  showAll,
  onShowAllChange,
  error,
}: Props) {
  const [search, setSearch] = useState('')
  const selected = useMemo(() => new Set(selectedIds), [selectedIds])

  const inRegion = useMemo(
    () => clusters.filter((cluster) => clusterInRegion(cluster, region)),
    [clusters, region],
  )
  const scoped = showAll ? clusters : inRegion
  const visible = scoped.filter((cluster) => matchesSearch(cluster, search))
  const groups = providers
    .map((provider) => ({
      provider,
      clusters: visible.filter((cluster) => cluster.provider === provider),
    }))
    .filter((group) => group.clusters.length > 0)
  const visibleIds = new Set(visible.map((cluster) => cluster.id))
  const hiddenSelected = selectedIds.filter((id) => !visibleIds.has(id)).length

  function toggle(id: string) {
    onSelectionChange(
      selected.has(id) ? selectedIds.filter((item) => item !== id) : [...selectedIds, id],
    )
  }

  function selectVisible() {
    onSelectionChange([
      ...selectedIds,
      ...visible.map((c) => c.id).filter((id) => !selected.has(id)),
    ])
  }

  let body
  if (loading) {
    body = <LoadingState label="Loading clusters…" rows={3} columns={5} />
  } else if (loadError) {
    body = (
      <ErrorState
        compact
        title="Clusters could not be loaded"
        message={loadError}
        onRetry={onRetry}
      />
    )
  } else if (clusters.length === 0) {
    body = (
      <EmptyState
        compact
        icon={<ClusterIcon />}
        title="No active clusters are available"
        description="Clusters appear here once a cloud source has discovered them."
        action={
          <Link className={buttonClass('secondary', 'sm')} to="/sources">
            View sources
          </Link>
        }
      />
    )
  } else if (scoped.length === 0) {
    body = (
      <EmptyState
        compact
        icon={<ClusterIcon />}
        title={`No clusters in ${region}`}
        description="Local clusters and clusters in other regions are hidden while the list follows the scope."
        action={
          <Button size="sm" onClick={() => onShowAllChange(true)}>
            Include every region
          </Button>
        }
      />
    )
  } else if (visible.length === 0) {
    body = (
      <EmptyState
        compact
        icon={<SearchIcon />}
        title={`No clusters match “${search.trim()}”`}
        description="Search matches cluster, source, location, and provider."
        action={
          <Button size="sm" onClick={() => setSearch('')}>
            Clear search
          </Button>
        }
      />
    )
  } else {
    body = (
      <div className="table-scroll">
        <table
          className="data-table target-table"
          aria-label="Target clusters"
          aria-describedby={error ? targetsErrorId : undefined}
        >
          <thead>
            <tr>
              <th scope="col" className="col-select">
                <span className="sr-only">Select</span>
              </th>
              <th scope="col">Cluster</th>
              <th scope="col" className="col-optional">
                Source
              </th>
              <th scope="col">Location</th>
              <th scope="col" className="col-optional">
                Kubernetes
              </th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          {groups.map((group) => (
            <tbody key={group.provider}>
              <tr className="target-group">
                <th scope="colgroup" colSpan={6}>
                  <span className="target-group-label">
                    <ProviderLogo provider={group.provider} />
                    {providerLabels[group.provider]}
                    <span className="target-group-meta">
                      {providerNames[group.provider]} · {plural(group.clusters.length, 'cluster')}
                    </span>
                  </span>
                </th>
              </tr>
              {group.clusters.map((cluster) => (
                <tr
                  className={selected.has(cluster.id) ? 'is-selected' : undefined}
                  key={cluster.id}
                  onClick={() => toggle(cluster.id)}
                >
                  <td className="col-select">
                    <input
                      type="checkbox"
                      className="checkbox"
                      aria-label={`Select ${cluster.name}`}
                      checked={selected.has(cluster.id)}
                      onClick={(event) => event.stopPropagation()}
                      onChange={() => toggle(cluster.id)}
                    />
                  </td>
                  <td>
                    <strong className="target-name">{cluster.name}</strong>
                  </td>
                  <td className="subtle col-optional">{cluster.sourceName}</td>
                  <td className="mono">{cluster.location || 'Unknown'}</td>
                  <td className="mono col-optional">{cluster.kubernetesVersion || 'Unknown'}</td>
                  <td>
                    <StatusBadge domain="cluster" status={cluster.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
    )
  }

  return (
    <div className="target-picker">
      <div className="target-toolbar">
        <SearchInput
          label="Search clusters"
          placeholder="Search clusters"
          value={search}
          onChange={setSearch}
        />
        <Switch
          label="Show all clusters"
          description={`Include local clusters and regions other than ${region}.`}
          checked={showAll}
          onChange={(event) => onShowAllChange(event.target.checked)}
        />
      </div>

      <div className="wizard-table" data-invalid={error ? true : undefined}>
        <div className="wizard-table-caption">
          <span>
            {showAll
              ? `${plural(clusters.length, 'cluster')} in every region`
              : `${inRegion.length} of ${plural(clusters.length, 'cluster')} in ${region}`}
          </span>
          <span className="target-selection">
            <strong className="tabular">{selectedIds.length} selected</strong>
            {hiddenSelected > 0 && <span className="subtle">({hiddenSelected} not shown)</span>}
            {visible.length > 0 && visible.some((cluster) => !selected.has(cluster.id)) && (
              <button type="button" className="link-button" onClick={selectVisible}>
                Select shown
              </button>
            )}
            {selectedIds.length > 0 && (
              <button type="button" className="link-button" onClick={() => onSelectionChange([])}>
                Clear
              </button>
            )}
          </span>
        </div>
        {body}
      </div>

      {error && (
        <p className="field-error target-error" id={targetsErrorId} role="alert">
          <ErrorIcon aria-hidden="true" />
          {error}
        </p>
      )}
    </div>
  )
}
