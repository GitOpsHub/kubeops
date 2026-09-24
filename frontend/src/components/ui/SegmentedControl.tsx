import { ToggleGroup, type ToggleOption } from './ToggleGroup'

export type SegmentOption<T extends string> = ToggleOption<T>

type Props<T extends string> = {
  /** Names the group for assistive technology. */
  label: string
  options: SegmentOption<T>[]
  value: T
  onChange: (value: T) => void
  size?: 'sm' | 'md'
  className?: string
}

/** A joined toggle group: view switches such as Tree / List. */
export function SegmentedControl<T extends string>({ className = '', ...props }: Props<T>) {
  return (
    <ToggleGroup
      {...props}
      appearance="segmented"
      className={`segmented ${className}`.trim()}
      itemClassName="segmented-option"
    />
  )
}
