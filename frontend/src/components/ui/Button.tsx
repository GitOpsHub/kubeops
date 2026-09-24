import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { buttonClass, type ButtonSize, type ButtonVariant } from './button-class'

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Shows a spinner and disables the button; the label stays so width holds. */
  loading?: boolean
  icon?: ReactNode
  /** Icon-only buttons still need a name; pass `aria-label`. */
  iconOnly?: boolean
}

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    icon,
    iconOnly = false,
    className = '',
    disabled,
    type = 'button',
    children,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClass(variant, size, `${iconOnly ? 'btn--icon' : ''} ${className}`.trim())}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="spinner" aria-hidden="true" /> : icon}
      {children}
    </button>
  )
})
