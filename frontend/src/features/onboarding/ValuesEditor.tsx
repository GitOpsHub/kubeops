import { useMemo, useRef } from 'react'
import { ErrorIcon, SuccessIcon } from '../../components/icons'
import { Field, Textarea } from '../../components/ui/Field'
import { plural } from '../../lib/format'
import { checkMapping } from './onboarding-wizard'

type Props = {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  /** A server or step error; the live YAML check is shown when there is none. */
  error?: string
  describedBy?: string
}

const minimumLines = 12

/**
 * A plain textarea dressed as a code editor. The gutter is decorative and
 * follows the textarea's scroll, so the control stays native for keyboard,
 * selection, and assistive technology.
 */
export function ValuesEditor({
  id,
  label,
  value,
  onChange,
  placeholder,
  error,
  describedBy,
}: Props) {
  const gutterRef = useRef<HTMLDivElement>(null)
  const check = useMemo(
    () => (value.trim() ? checkMapping(value, label.replace(/ override$/, '')) : null),
    [label, value],
  )
  const lineCount = Math.max(minimumLines, value.split('\n').length)
  const shownError = error || check?.error || ''
  const errorLine = !error ? check?.line : undefined

  return (
    <Field
      id={id}
      label={label}
      error={shownError || undefined}
      hint={
        !shownError && (
          <span className="values-status" data-tone={check ? 'ok' : 'idle'}>
            {check ? (
              <>
                <SuccessIcon aria-hidden="true" />
                Valid YAML mapping · {plural(check.keys ?? 0, 'top-level key')}
              </>
            ) : (
              'Empty — the chart defaults apply unchanged.'
            )}
          </span>
        )
      }
    >
      <div className="code-editor" data-invalid={shownError ? true : undefined}>
        <div className="code-editor-gutter" ref={gutterRef} aria-hidden="true">
          {Array.from({ length: lineCount }, (_, index) => (
            <span key={index} className={errorLine === index + 1 ? 'is-error' : undefined}>
              {errorLine === index + 1 ? <ErrorIcon /> : index + 1}
            </span>
          ))}
        </div>
        <Textarea
          className="code-editor-input"
          value={value}
          rows={minimumLines}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          aria-describedby={describedBy}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          onScroll={(event) => {
            if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop
          }}
        />
      </div>
    </Field>
  )
}
