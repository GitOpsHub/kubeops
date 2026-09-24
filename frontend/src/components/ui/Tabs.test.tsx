import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { Tabs } from './Tabs'

function Harness() {
  const [active, setActive] = useState('one')
  return (
    <Tabs
      label="Details"
      activeId={active}
      onChange={setActive}
      items={[
        { id: 'one', label: 'Resources', content: <p>Resource tree</p> },
        { id: 'two', label: 'Timeline', content: <p>Events</p> },
      ]}
    />
  )
}

describe('Tabs', () => {
  it('points every tab at a panel that exists', () => {
    render(<Harness />)

    for (const tab of screen.getAllByRole('tab')) {
      const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '')
      expect(panel).not.toBeNull()
      expect(panel).toHaveAttribute('role', 'tabpanel')
    }
  })

  it('shows only the selected panel and moves with the arrow keys', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    expect(screen.getByRole('tabpanel', { name: 'Resources' })).toHaveTextContent('Resource tree')
    expect(screen.queryByText('Events')).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Resources' }))
    await user.keyboard('{ArrowRight}')

    expect(screen.getByRole('tab', { name: 'Timeline' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Timeline' })).toHaveFocus()
    expect(screen.getByRole('tabpanel', { name: 'Timeline' })).toHaveTextContent('Events')
    expect(screen.queryByText('Resource tree')).not.toBeInTheDocument()
  })
})
