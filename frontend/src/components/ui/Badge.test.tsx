import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StatusBadge } from './Badge'

describe('StatusBadge', () => {
  it.each([
    // Case-only differences keep the API's word; CSS capitalises it.
    ['cluster', 'active', 'active', true],
    // Already canonical: no CSS casing, so "Out of Sync" never becomes "Out Of Sync".
    ['sync', 'Synced', 'Synced', false],
    ['sync', 'Out of Sync', 'Out of Sync', false],
    // A canonical label that adds words is rendered as the label.
    ['sync', 'OutOfSync', 'Out of Sync', false],
  ] as const)('%s %s renders "%s"', (domain, status, text, cased) => {
    render(<StatusBadge domain={domain} status={status} />)
    const badge = screen.getByText(text)
    expect(badge.classList.contains('status-badge--cased')).toBe(cased)
  })
})
