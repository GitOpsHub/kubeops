import {
  useEffect,
  useId,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { useNavigate } from 'react-router-dom'
import { errorMessage, isAbortError } from '../api/client'
import { getClusters, type Cluster } from '../api/inventory'
import { getAllApplicationOnboardings } from '../api/onboarding'
import {
  ApplicationsIcon,
  CheckIcon,
  ClusterIcon,
  DarkThemeIcon,
  LightThemeIcon,
  SearchIcon,
  SyncIcon,
  SystemThemeIcon,
} from '../components/icons'
import { Dialog, DialogTitle } from '../components/ui/Dialog'
import { Kbd } from '../components/ui/Kbd'
import { useToast } from '../components/ui/toast-context'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { useTheme, type ThemePreference } from '../hooks/useTheme'
import {
  groupApplications,
  type ApplicationGroup,
} from '../features/applications/application-groups'
import { providerLabels } from '../lib/providers'
import { filterCommands, queueAllSourceSyncs, type Command } from './commands'
import { navItems } from './navigation'
import './CommandPalette.css'

const clusterSearchDebounceMs = 200
const clusterResultLimit = 8
const applicationResultLimit = 8

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called once syncs are queued, so the shell's heartbeat catches up at once. */
  onSyncQueued: () => void
}

/**
 * ⌘K: jump to any page, application, or cluster, or run a shell-level action,
 * without leaving the keyboard. Focus stays in the input throughout and the
 * highlighted result is conveyed with `aria-activedescendant`, the combobox
 * pattern screen readers expect for a filter-as-you-type list.
 */
export function CommandPalette({ open, onOpenChange, onSyncQueued }: Props) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      className="command-palette"
      size="md"
      describedBy={false}
    >
      <DialogTitle className="sr-only">Command palette</DialogTitle>
      {/* Mounted only while open, so every opening starts from an empty query
          and fresh results. */}
      {open && <PaletteBody close={() => onOpenChange(false)} onSyncQueued={onSyncQueued} />}
    </Dialog>
  )
}

type Remote<T> = { status: 'loading' | 'ready' | 'error'; items: T[] }

const themeActions: { value: ThemePreference; label: string; icon: Command['icon'] }[] = [
  { value: 'light', label: 'Light', icon: LightThemeIcon },
  { value: 'dark', label: 'Dark', icon: DarkThemeIcon },
  { value: 'system', label: 'System', icon: SystemThemeIcon },
]

function optionId(listId: string, command: Command) {
  return `${listId}-${command.id.replace(/[^\w-]/g, '_')}`
}

function PaletteBody({ close, onSyncQueued }: { close: () => void; onSyncQueued: () => void }) {
  const navigate = useNavigate()
  const toast = useToast()
  const { preference, setPreference } = useTheme()
  const listId = useId()
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const search = query.trim()
  const clusterSearch = useDebouncedValue(search, clusterSearchDebounceMs)

  // Applications are grouped client-side exactly as the Applications page
  // groups them, so fetch the list once per opening and filter locally.
  const [applications, setApplications] = useState<Remote<ApplicationGroup>>({
    status: 'loading',
    items: [],
  })
  useEffect(() => {
    const controller = new AbortController()
    getAllApplicationOnboardings({}, controller.signal)
      .then((records) => setApplications({ status: 'ready', items: groupApplications(records) }))
      .catch((error) => {
        if (!isAbortError(error)) setApplications({ status: 'error', items: [] })
      })
    return () => controller.abort()
  }, [])

  // Clusters can number in the thousands, so they are searched server-side.
  const [clusters, setClusters] = useState<Remote<Cluster> & { search: string }>({
    status: 'ready',
    items: [],
    search: '',
  })
  useEffect(() => {
    if (!clusterSearch) return
    const controller = new AbortController()
    getClusters({ search: clusterSearch, pageSize: clusterResultLimit }, controller.signal)
      .then((page) => setClusters({ status: 'ready', items: page.items, search: clusterSearch }))
      .catch((error) => {
        if (!isAbortError(error)) setClusters({ status: 'error', items: [], search: clusterSearch })
      })
    return () => controller.abort()
  }, [clusterSearch])

  const commands = useMemo<Command[]>(() => {
    const go = (to: string) => () => navigate(to)
    const list: Command[] = navItems
      .filter((item) => item.to !== '/applications/new')
      .map((item) => ({
        id: `nav:${item.to}`,
        group: 'navigate',
        label: item.label,
        keywords: item.keywords,
        icon: item.icon,
        perform: go(item.to),
      }))

    list.push(
      {
        id: 'action:onboard',
        group: 'actions',
        label: 'Onboard application',
        detail: 'Deploy a Helm chart to one or more clusters',
        keywords: ['new', 'create', 'deploy', 'add'],
        icon: navItems.find((item) => item.to === '/applications/new')?.icon,
        perform: go('/applications/new'),
      },
      {
        id: 'action:sync-all',
        group: 'actions',
        label: 'Sync all cloud sources',
        detail: 'Queue a discovery run for every enabled source',
        keywords: ['discover', 'refresh', 'inventory', 'clusters'],
        icon: SyncIcon,
        perform: () => {
          toast
            .promise(queueAllSourceSyncs(), {
              loading: 'Queueing a sync for every cloud source…',
              success: ({ queued, failed }) =>
                queued === 0 && failed.length === 0
                  ? 'No enabled cloud sources to sync.'
                  : `Sync queued for ${queued} of ${queued + failed.length} cloud sources.`,
              error: (error) => errorMessage(error, 'Could not queue cloud source syncs.'),
            })
            .then(({ failed }) => {
              onSyncQueued()
              if (failed.length > 0) {
                toast.error(`${failed.length} cloud source sync could not be queued.`, {
                  description: failed.map((item) => `${item.name}: ${item.message}`).join(' · '),
                })
              }
            })
            // The toast already reported the failure.
            .catch(() => {})
        },
      },
      ...themeActions.map(({ value, label, icon }) => ({
        id: `theme:${value}`,
        group: 'actions' as const,
        label: `Theme: ${label}`,
        detail: preference === value ? 'Current' : undefined,
        keywords: ['appearance', 'mode', 'colour', 'color', 'toggle theme'],
        icon: preference === value ? CheckIcon : icon,
        perform: () => setPreference(value),
      })),
    )

    // Records only appear once there is something to match; an empty
    // palette stays a short, predictable list of places and actions.
    if (search) {
      list.push(
        ...applications.items.map((group) => ({
          id: `app:${group.applicationId}`,
          group: 'applications' as const,
          label: group.name,
          detail: [group.namespaces.join(', '), group.environments.join(' · ')]
            .filter(Boolean)
            .join(' — '),
          keywords: [...group.namespaces, ...group.environments, ...group.regions],
          icon: ApplicationsIcon,
          perform: go(`/applications/${encodeURIComponent(group.applicationId)}`),
        })),
      )
      if (clusters.search === clusterSearch && clusterSearch === search) {
        list.push(
          ...clusters.items.map((cluster) => ({
            id: `cluster:${cluster.id}`,
            group: 'clusters' as const,
            label: cluster.name,
            detail: [providerLabels[cluster.provider] ?? cluster.provider, cluster.location]
              .filter(Boolean)
              .join(' · '),
            icon: ClusterIcon,
            serverMatched: true,
            perform: go(`/clusters?search=${encodeURIComponent(cluster.name)}`),
          })),
        )
      }
    }
    return list
  }, [
    applications.items,
    clusterSearch,
    clusters,
    navigate,
    onSyncQueued,
    preference,
    search,
    setPreference,
    toast,
  ])

  const sections = useMemo(
    () =>
      filterCommands(commands, query).map((section) =>
        section.id === 'applications'
          ? { ...section, commands: section.commands.slice(0, applicationResultLimit) }
          : section,
      ),
    [commands, query],
  )
  const results = sections.flatMap((section) => section.commands)
  const active = results.find((command) => command.id === activeId) ?? results[0] ?? null
  const activeDomId = active ? optionId(listId, active) : undefined

  useEffect(() => {
    if (activeDomId) document.getElementById(activeDomId)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeDomId])

  const run = (command: Command) => {
    close()
    command.perform()
  }

  const move = (delta: number) => {
    if (results.length === 0) return
    const index = active ? results.indexOf(active) : -1
    const next = (index + delta + results.length) % results.length
    setActiveId(results[next].id)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      move(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      move(-1)
    } else if (event.key === 'Enter' && active) {
      event.preventDefault()
      run(active)
    }
  }

  const searchingClusters =
    Boolean(search) && (clusterSearch !== search || clusters.search !== clusterSearch)
  const busy = Boolean(search) && (applications.status === 'loading' || searchingClusters)
  const unavailable = [
    search && applications.status === 'error' && 'applications',
    search && clusters.status === 'error' && clusters.search === search && 'clusters',
  ].filter(Boolean)

  return (
    <div className="command-body">
      <div className="command-search">
        <SearchIcon className="command-search-icon" />
        <input
          className="command-input"
          role="combobox"
          aria-label="Search pages, applications, and clusters"
          aria-expanded={results.length > 0}
          aria-controls={results.length > 0 ? listId : undefined}
          aria-activedescendant={activeDomId}
          aria-autocomplete="list"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Search pages, applications, clusters…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            // A new query starts from its best match.
            setActiveId(null)
          }}
          onKeyDown={onKeyDown}
        />
        {busy && <span className="spinner command-spinner" aria-hidden="true" />}
        <span className="command-esc" aria-hidden="true">
          <Kbd>Esc</Kbd>
        </span>
      </div>

      <div className="command-results">
        {results.length > 0 ? (
          <div role="listbox" id={listId} aria-label="Results">
            {sections.map((section) => (
              <div
                key={section.id}
                role="group"
                aria-labelledby={`${listId}-${section.id}`}
                className="command-group"
              >
                <div
                  className="command-group-label"
                  id={`${listId}-${section.id}`}
                  role="presentation"
                >
                  {section.label}
                </div>
                {section.commands.map((command) => {
                  const selected = command === active
                  const Icon = command.icon
                  return (
                    <div
                      key={command.id}
                      id={optionId(listId, command)}
                      role="option"
                      aria-selected={selected}
                      className={selected ? 'command-option is-active' : 'command-option'}
                      // Keep focus in the input: the listbox is driven from there.
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseMove={() => {
                        if (!selected) setActiveId(command.id)
                      }}
                      onClick={() => run(command)}
                    >
                      <span className="command-option-icon" aria-hidden="true">
                        {Icon && <Icon />}
                      </span>
                      <span className="command-option-text">
                        <span className="command-option-label truncate">{command.label}</span>
                        {command.detail && (
                          <span className="command-option-detail truncate">{command.detail}</span>
                        )}
                      </span>
                      {selected && (
                        <span className="command-option-enter" aria-hidden="true">
                          <Kbd>↵</Kbd>
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        ) : (
          <p className="command-empty">{busy ? 'Searching…' : `No results for “${search}”`}</p>
        )}
      </div>

      <div className="command-footer">
        <span className="command-footer-hint" aria-hidden="true">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> navigate
        </span>
        <span className="command-footer-hint" aria-hidden="true">
          <Kbd>↵</Kbd> open
        </span>
        <span className="command-footer-hint" aria-hidden="true">
          <Kbd>Esc</Kbd> close
        </span>
        <span className="command-footer-status" role="status">
          {unavailable.length > 0
            ? `Could not load ${unavailable.join(' or ')}.`
            : search
              ? `${results.length} ${results.length === 1 ? 'result' : 'results'}`
              : ''}
        </span>
      </div>
    </div>
  )
}
