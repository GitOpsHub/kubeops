import './Button.css'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

/**
 * The button look as a class list, for elements that must stay links (a
 * router `Link` or an external anchor) but should read as a button.
 */
export function buttonClass(
  variant: ButtonVariant = 'secondary',
  size: ButtonSize = 'md',
  extra = '',
) {
  return `btn btn--${variant} btn--${size}${extra ? ` ${extra}` : ''}`
}
