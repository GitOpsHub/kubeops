import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StatusBadge } from './Badge'

describe('StatusBadge', () => {
  it.each([
    // Case-only differences keep the API's word; CSS capitalises it.
    ['cluster', 'active', 'active', true],
    ['sync', 'Synced', 'Synced', true],
    // A canonical label that adds words is rendered as the label.
    ['sync', 'OutOfSync', 'Out of Sync', false],
  ] as const)('%s %s renders "%s"', (domain, status, text, cased) => {
    render(<StatusBadge domain={domain} status={status} />)
    const badge = screen.getByText(text)
    expect(badge.classList.contains('status-badge--cased')).toBe(cased)
  })
})
