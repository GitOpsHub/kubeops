import { createContext, useContext, type AriaAttributes } from 'react'

export type FieldControlProps = {
  id: string
  'aria-describedby'?: string
  'aria-invalid'?: AriaAttributes['aria-invalid']
  required?: boolean
}

export const FieldContext = createContext<FieldControlProps | null>(null)

/**
 * The id and ARIA wiring a control needs from the `Field` around it. Explicit
 * props on the control win, so a control can still be used on its own.
 */
export function useFieldControl<T extends Partial<FieldControlProps>>(props: T): T {
  const field = useContext(FieldContext)
  if (!field) return props
  const describedBy = [field['aria-describedby'], props['aria-describedby']]
    .filter(Boolean)
    .join(' ')
  return {
    ...field,
    ...props,
    id: props.id ?? field.id,
    'aria-describedby': describedBy || undefined,
    'aria-invalid': props['aria-invalid'] ?? field['aria-invalid'],
  }
}
