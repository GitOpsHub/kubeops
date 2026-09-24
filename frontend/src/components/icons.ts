/**
 * The only door to the icon library. Features import from here, never from
 * `lucide-react` directly, so the set stays small, consistent, and swappable,
 * and a bundle audit has one file to read. Brand, Kubernetes, and Argo glyphs
 * are not generic icons and stay in their own components.
 *
 * Lucide marks an icon `aria-hidden` unless it is given an accessible name, so
 * a decorative icon needs no extra props.
 */
import { ArrowLeftRight, type LucideProps } from 'lucide-react'
import { createElement } from 'react'

export type { LucideIcon as IconComponent, LucideProps as IconProps } from 'lucide-react'

export {
  ArrowDown as SortDescendingIcon,
  ArrowLeft as BackIcon,
  ArrowUp as SortAscendingIcon,
  Check as CheckIcon,
  ChevronDown as ChevronDownIcon,
  ChevronLeft as ChevronLeftIcon,
  ChevronRight as ChevronRightIcon,
  ChevronsLeft as ChevronsLeftIcon,
  ChevronsRight as ChevronsRightIcon,
  CircleAlert as ErrorIcon,
  CircleCheck as SuccessIcon,
  CircleDashed as UnknownIcon,
  CirclePause as SuspendedIcon,
  CircleQuestionMark as HelpIcon,
  CircleX as FailedIcon,
  Clock as ClockIcon,
  Cloud as CloudIcon,
  Command as CommandIcon,
  Copy as CopyIcon,
  Download as DownloadIcon,
  Ellipsis as MoreIcon,
  ExternalLink as ExternalLinkIcon,
  FileText as ManifestIcon,
  Funnel as FilterIcon,
  GitCommitHorizontal as CommitIcon,
  Heart as HealthIcon,
  Inbox as EmptyIcon,
  Info as InfoIcon,
  LayoutDashboard as OverviewIcon,
  Layers as ApplicationsIcon,
  LoaderCircle as SpinnerIcon,
  Menu as MenuIcon,
  Minus as MinusIcon,
  Monitor as SystemThemeIcon,
  Moon as DarkThemeIcon,
  PanelLeftClose as CollapseSidebarIcon,
  PanelLeftOpen as ExpandSidebarIcon,
  Pause as PauseIcon,
  Play as PlayIcon,
  Plus as PlusIcon,
  RefreshCw as SyncIcon,
  RotateCw as RetryIcon,
  Rocket as DeployIcon,
  ScrollText as LogsIcon,
  Search as SearchIcon,
  Server as ClusterIcon,
  Sun as LightThemeIcon,
  Terminal as TerminalIcon,
  Trash as DeleteIcon,
  TriangleAlert as WarningIcon,
  X as CloseIcon,
} from 'lucide-react'

/**
 * Horizontal arrows for scaling. The class is load-bearing: tests and the
 * detail header's CSS find the Scale button's glyph by it.
 */
export function ScaleIcon({ className, ...props }: LucideProps) {
  return createElement(ArrowLeftRight, {
    ...props,
    className: className ? `scale-horizontal-icon ${className}` : 'scale-horizontal-icon',
  })
}
