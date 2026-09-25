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
  ArrowDownToLine as JumpToLatestIcon,
  ArrowLeft as BackIcon,
  ArrowUp as SortAscendingIcon,
  CaseSensitive as CaseSensitiveIcon,
  Check as CheckIcon,
  ChevronDown as ChevronDownIcon,
  ChevronLeft as ChevronLeftIcon,
  ChevronRight as ChevronRightIcon,
  ChevronUp as ChevronUpIcon,
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
  Eraser as ClearIcon,
  ExternalLink as ExternalLinkIcon,
  FileText as ManifestIcon,
  Funnel as FilterIcon,
  GitCommitHorizontal as CommitIcon,
  // A generic Git-to-cluster reconcile mark for Argo CD links and sections;
  // the Argo project logo is trademarked, so it is deliberately not drawn.
  GitCompareArrows as ArgoIcon,
  Heart as HealthIcon,
  Inbox as EmptyIcon,
  Info as InfoIcon,
  LayoutDashboard as OverviewIcon,
  Layers as ApplicationsIcon,
  LoaderCircle as SpinnerIcon,
  Maximize2 as FullscreenIcon,
  Menu as MenuIcon,
  Minimize2 as ExitFullscreenIcon,
  Minus as MinusIcon,
  Monitor as SystemThemeIcon,
  Moon as DarkThemeIcon,
  PanelLeftClose as CollapseSidebarIcon,
  PanelLeftOpen as ExpandSidebarIcon,
  Pause as PauseIcon,
  Play as PlayIcon,
  Plus as PlusIcon,
  RefreshCw as SyncIcon,
  Regex as RegexIcon,
  RotateCw as RetryIcon,
  Rocket as DeployIcon,
  ScrollText as LogsIcon,
  Search as SearchIcon,
  Server as ClusterIcon,
  Sun as LightThemeIcon,
  Terminal as TerminalIcon,
  Trash as DeleteIcon,
  TriangleAlert as WarningIcon,
  WrapText as WrapIcon,
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
