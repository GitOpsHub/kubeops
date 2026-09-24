import type { SVGProps } from 'react'

/** Line icons for the primary navigation, drawn on one 20px grid. */

function Icon({ d, ...props }: SVGProps<SVGSVGElement> & { d: string }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" {...props}>
      <path d={d} />
    </svg>
  )
}

export const OverviewIcon = () => (
  <Icon d="M3.5 3.5h5v6h-5zM11.5 3.5h5v3.5h-5zM11.5 10h5v6.5h-5zM3.5 12.5h5v4h-5z" />
)

export const ClustersIcon = () => (
  <Icon d="M10 2.5 16.5 6v8L10 17.5 3.5 14V6L10 2.5ZM3.5 6 10 9.5 16.5 6M10 9.5v8" />
)

export const ApplicationsIcon = () => (
  <Icon d="M10 3 17 6.5 10 10 3 6.5 10 3ZM3 10l7 3.5 7-3.5M3 13.5 10 17l7-3.5" />
)

export const SourcesIcon = () => (
  <Icon d="M6 15.5h8.5a3.5 3.5 0 0 0 .4-7A5 5 0 0 0 5.2 8a3.8 3.8 0 0 0 .8 7.5Z" />
)

export const MenuIcon = () => <Icon d="M3.5 5.5h13M3.5 10h13M3.5 14.5h13" />

export const CollapseIcon = ({ collapsed }: { collapsed: boolean }) => (
  <Icon d={collapsed ? 'M8 5l5 5-5 5M3.5 3.5v13' : 'M12 5 7 10l5 5M16.5 3.5v13'} />
)
