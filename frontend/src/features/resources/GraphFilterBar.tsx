import { ChevronDownIcon } from '../../components/icons'
import { KubernetesResourceIcon } from '../../components/KubernetesResourceIcon'
import { Switch } from '../../components/ui/Field'
import { FilterMenu, type FilterMenuOption } from '../../components/ui/FilterMenu'
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuLabel,
  MenuSeparator,
} from '../../components/ui/Menu'
import { SearchInput } from '../../components/ui/SearchInput'
import { StatusDot } from '../../components/ui/StatusDot'
import {
  healthFilterLabels,
  syncFilterLabels,
  type ResourceFilters,
} from '../../lib/resource-graph'
import '../../components/ui/FilterMenu.css'

type Props = {
  filters: ResourceFilters
  onChange: (filters: ResourceFilters) => void
  /** Every kind present, with how many resources of each. */
  kindCounts: Map<string, number>
  healthCounts: Map<string, number>
  syncCounts: Map<string, number>
}

function countedOptions(
  labels: string[],
  counts: Map<string, number>,
  selected: string,
  domain: 'health' | 'sync',
): FilterMenuOption[] {
  // Known buckets first in their usual order, then anything unexpected the
  // API reported, so a new state is filterable rather than invisible.
  const all = [...labels, ...[...counts.keys()].filter((label) => !labels.includes(label))]
  return all
    .filter((label) => counts.has(label) || label === selected)
    .map((label) => ({
      value: label,
      icon: <StatusDot domain={domain} status={label} size="sm" plain inFlight={false} />,
      label: (
        <span className="graph-filter-option">
          {label}
          <span className="graph-filter-count">{counts.get(label) ?? 0}</span>
        </span>
      ),
    }))
}

function kindSummary(kinds: string[]) {
  if (kinds.length === 0) return 'All kinds'
  if (kinds.length <= 2) return kinds.join(', ')
  return `${kinds.length} kinds`
}

/**
 * Narrows the graph by kind, health, and sync, and hides the churn a
 * Deployment owns. The search is different in kind: it dims non-matches in
 * place rather than removing them, so a match is still seen in its tree.
 */
export function GraphFilterBar({ filters, onChange, kindCounts, healthCounts, syncCounts }: Props) {
  const set = (patch: Partial<ResourceFilters>) => onChange({ ...filters, ...patch })
  const kinds = [...kindCounts.keys()].sort()

  function toggleKind(kind: string, checked: boolean) {
    set({
      kinds: checked
        ? [...filters.kinds, kind].sort()
        : filters.kinds.filter((item) => item !== kind),
    })
  }

  return (
    <div className="graph-filters">
      <SearchInput
        className="graph-search"
        label="Search resources"
        placeholder="Search by name or kind"
        value={filters.search}
        onChange={(search) => set({ search })}
      />
      <Menu
        align="start"
        className="filter-menu"
        trigger={
          <button
            type="button"
            className={`filter-button${filters.kinds.length ? ' is-active' : ''}`}
          >
            <span className="filter-button-label">Kind</span>{' '}
            <span className="filter-button-value">{kindSummary(filters.kinds)}</span>
            <ChevronDownIcon aria-hidden="true" />
          </button>
        }
      >
        <MenuLabel>Show kinds</MenuLabel>
        {kinds.map((kind) => (
          <MenuCheckboxItem
            key={kind}
            checked={filters.kinds.includes(kind)}
            onCheckedChange={(checked) => toggleKind(kind, checked)}
            icon={<KubernetesResourceIcon kind={kind} />}
          >
            <span className="graph-filter-option">
              {kind}
              <span className="graph-filter-count">{kindCounts.get(kind)}</span>
            </span>
          </MenuCheckboxItem>
        ))}
        {filters.kinds.length > 0 && (
          <>
            <MenuSeparator />
            <MenuItem onSelect={() => set({ kinds: [] })}>Show all kinds</MenuItem>
          </>
        )}
      </Menu>
      <FilterMenu
        label="Health"
        allLabel="Any health"
        value={filters.health}
        onChange={(health) => set({ health })}
        options={countedOptions(healthFilterLabels, healthCounts, filters.health, 'health')}
        fallbackLabel={(value) => value}
      />
      <FilterMenu
        label="Sync"
        allLabel="Any sync"
        value={filters.sync}
        onChange={(sync) => set({ sync })}
        options={countedOptions(syncFilterLabels, syncCounts, filters.sync, 'sync')}
        fallbackLabel={(value) => value}
      />
      <Switch
        className="graph-filter-switch"
        label="Hide ReplicaSets & Pods"
        checked={filters.hideReplicaSetsAndPods}
        onChange={(event) => set({ hideReplicaSetsAndPods: event.target.checked })}
      />
    </div>
  )
}
