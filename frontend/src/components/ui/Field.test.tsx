import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { Checkbox, Field, RadioCards, Select, Switch, Textarea, TextInput } from './Field'

describe('Field', () => {
  it('labels its control and describes it with the hint', () => {
    render(
      <Field label="Namespace" hint="Lowercase letters and dashes.">
        <TextInput />
      </Field>,
    )

    const input = screen.getByRole('textbox', { name: 'Namespace' })
    expect(input).toHaveAccessibleDescription('Lowercase letters and dashes.')
    expect(input).not.toHaveAttribute('aria-invalid')
  })

  it('marks the control invalid and reads the error after the hint', () => {
    render(
      <Field label="Replicas" hint="From 1 to 1000." error="Enter a whole number.">
        <TextInput type="number" />
      </Field>,
    )

    const input = screen.getByRole('spinbutton', { name: 'Replicas' })
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAccessibleDescription('From 1 to 1000. Enter a whole number.')
  })

  it('keeps a control’s own description alongside the field’s', () => {
    render(
      <>
        <p id="extra">Applies to every region.</p>
        <Field label="Environment" error="Required.">
          <Select aria-describedby="extra">
            <option>dev</option>
          </Select>
        </Field>
      </>,
    )

    expect(screen.getByRole('combobox', { name: 'Environment' })).toHaveAccessibleDescription(
      'Required. Applies to every region.',
    )
  })

  it('marks required fields for assistive technology, not only visually', () => {
    render(
      <Field label="Values" required>
        <Textarea />
      </Field>,
    )

    expect(screen.getByRole('textbox', { name: 'Values' })).toBeRequired()
  })

  it('renders checkboxes and switches as their native roles', async () => {
    const user = userEvent.setup()
    render(
      <>
        <Checkbox label="Prune" description="Delete resources no longer in Git." />
        <Switch label="Show all clusters" />
      </>,
    )

    const prune = screen.getByRole('checkbox', { name: 'Prune' })
    expect(prune).toHaveAccessibleDescription('Delete resources no longer in Git.')
    const all = screen.getByRole('switch', { name: 'Show all clusters' })
    await user.click(all)
    expect(all).toBeChecked()
  })

  it('offers radio cards as one named group', async () => {
    const user = userEvent.setup()
    function Picker() {
      const [value, setValue] = useState<'dev' | 'prod' | ''>('')
      return (
        <RadioCards
          legend="Environment"
          name="environment"
          value={value}
          onChange={setValue}
          options={[
            { value: 'dev', label: 'Development' },
            { value: 'prod', label: 'Production', description: 'Customer traffic.' },
          ]}
        />
      )
    }
    render(<Picker />)

    expect(screen.getByRole('group', { name: 'Environment' })).toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: /Production/ }))
    expect(screen.getByRole('radio', { name: /Production/ })).toBeChecked()
  })
})
