import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { FieldContext, useFieldControl } from './field-context'
import './Field.css'

type FieldProps = {
  label: ReactNode
  /** Guidance shown under the control and read after its name. */
  hint?: ReactNode
  /** Marks the control invalid and is announced with it. */
  error?: ReactNode
  required?: boolean
  /** Use when something outside needs to point at the control. */
  id?: string
  className?: string
  children: ReactNode
}

/**
 * A labelled control with its hint and error. The control inside — a
 * `TextInput`, `Select`, or `Textarea` — picks up its id, `aria-describedby`
 * (hint and error), and `aria-invalid` from here, so no form hand-wires them.
 */
export function Field({ label, hint, error, required, id, className = '', children }: FieldProps) {
  const generated = useId()
  const controlId = id ?? `${generated}-control`
  const hintId = `${controlId}-hint`
  const errorId = `${controlId}-error`
  const describedBy = [hint && hintId, error && errorId].filter(Boolean).join(' ')

  return (
    <FieldContext.Provider
      value={{
        id: controlId,
        'aria-describedby': describedBy || undefined,
        'aria-invalid': error ? true : undefined,
        required,
      }}
    >
      <div className={`field ${className}`.trim()} data-invalid={error ? true : undefined}>
        <label htmlFor={controlId}>
          {label}
          {required && (
            <span className="field-required" aria-hidden="true">
              {' '}
              *
            </span>
          )}
        </label>
        {children}
        {hint && (
          <p className="field-hint" id={hintId}>
            {hint}
          </p>
        )}
        <FieldMessage id={errorId}>{error}</FieldMessage>
      </div>
    </FieldContext.Provider>
  )
}

/**
 * The error slot. The live region is mounted before any error so a screen
 * reader hears the message when validation fills it in. It stays polite and
 * role-less: an assertive `alert` per field would talk over the focus move to
 * the first invalid control and be confused with a form's own alert.
 */
function FieldMessage({ id, children }: { id: string; children?: ReactNode }) {
  return (
    <div className="field-message" aria-live="polite">
      {children && (
        <p className="field-error" id={id}>
          {children}
        </p>
      )}
    </div>
  )
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextInput({ className = '', ...props }, ref) {
    const wired = useFieldControl(props)
    return <input ref={ref} className={`input ${className}`.trim()} {...wired} />
  },
)

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className = '', ...props }, ref) {
    const wired = useFieldControl(props)
    return <select ref={ref} className={`select ${className}`.trim()} {...wired} />
  },
)

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className = '', ...props }, ref) {
  const wired = useFieldControl(props)
  return <textarea ref={ref} className={`textarea ${className}`.trim()} {...wired} />
})

type CheckProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  label: ReactNode
  description?: ReactNode
}

/** A checkbox with its label beside it; the whole row is the hit target. */
export const Checkbox = forwardRef<HTMLInputElement, CheckProps>(function Checkbox(
  { label, description, className = '', ...props },
  ref,
) {
  const descriptionId = useId()
  const labelId = useId()
  return (
    <label className={`check ${className}`.trim()}>
      <input
        ref={ref}
        type="checkbox"
        className="check-input"
        // Named by the label alone; the description is read after it.
        aria-labelledby={labelId}
        aria-describedby={description ? descriptionId : undefined}
        {...props}
      />
      <span className="check-copy">
        <span className="check-label" id={labelId}>
          {label}
        </span>
        {description && (
          <span className="check-description" id={descriptionId}>
            {description}
          </span>
        )}
      </span>
    </label>
  )
})

/** An on/off setting that applies immediately; announced as a switch. */
export const Switch = forwardRef<HTMLInputElement, CheckProps>(function Switch(
  { label, description, className = '', ...props },
  ref,
) {
  const descriptionId = useId()
  const labelId = useId()
  return (
    <label className={`check switch ${className}`.trim()}>
      <input
        ref={ref}
        type="checkbox"
        role="switch"
        className="switch-input"
        aria-labelledby={labelId}
        aria-describedby={description ? descriptionId : undefined}
        {...props}
      />
      <span className="switch-track" aria-hidden="true" />
      <span className="check-copy">
        <span className="check-label" id={labelId}>
          {label}
        </span>
        {description && (
          <span className="check-description" id={descriptionId}>
            {description}
          </span>
        )}
      </span>
    </label>
  )
})

export type RadioCardOption<T extends string> = {
  value: T
  label: ReactNode
  description?: ReactNode
  icon?: ReactNode
  disabled?: boolean
}

type RadioCardsProps<T extends string> = {
  legend: ReactNode
  name: string
  value: T | ''
  onChange: (value: T) => void
  options: RadioCardOption<T>[]
  error?: ReactNode
  /** Keeps the legend for assistive technology but hides it visually. */
  hideLegend?: boolean
  className?: string
}

/** One choice from a few, each with room to explain itself. Native radios underneath. */
export function RadioCards<T extends string>({
  legend,
  name,
  value,
  onChange,
  options,
  error,
  hideLegend = false,
  className = '',
}: RadioCardsProps<T>) {
  const errorId = useId()
  return (
    <fieldset
      className={`radio-cards ${className}`.trim()}
      aria-describedby={error ? errorId : undefined}
      aria-invalid={error ? true : undefined}
    >
      <legend className={hideLegend ? 'sr-only' : 'radio-cards-legend'}>{legend}</legend>
      <div className="radio-cards-options">
        {options.map((option) => (
          <label
            key={option.value}
            className={option.value === value ? 'radio-card is-selected' : 'radio-card'}
            data-disabled={option.disabled || undefined}
          >
            <input
              type="radio"
              className="radio-card-input"
              name={name}
              value={option.value}
              checked={option.value === value}
              disabled={option.disabled}
              onChange={() => onChange(option.value)}
            />
            {option.icon && (
              <span className="radio-card-icon" aria-hidden="true">
                {option.icon}
              </span>
            )}
            <span className="radio-card-copy">
              <span className="radio-card-label">{option.label}</span>
              {option.description && (
                <span className="radio-card-description">{option.description}</span>
              )}
            </span>
          </label>
        ))}
      </div>
      <FieldMessage id={errorId}>{error}</FieldMessage>
    </fieldset>
  )
}
