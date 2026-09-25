import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { useUrlState } from './useUrlState'

const defaults = { provider: 'all', search: '', page: '1' }

function setup(route: string) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
  )
  return renderHook(
    () => {
      const [values, update] = useUrlState(defaults)
      return { values, update, location: useLocation() }
    },
    { wrapper },
  )
}

describe('useUrlState', () => {
  it.each([
    ['/list', { provider: 'all', search: '', page: '1' }],
    ['/list?provider=aws&search=prod', { provider: 'aws', search: 'prod', page: '1' }],
    ['/list?page=3&other=kept', { provider: 'all', search: '', page: '3' }],
  ])('reads %s over the defaults', (route, expected) => {
    const { result } = setup(route)
    expect(result.current.values).toEqual(expected)
  })

  it.each([
    ['writes a changed value', { search: 'payments' }, 'other=kept&provider=aws&search=payments'],
    ['drops a value equal to its default', { provider: 'all' }, 'other=kept'],
    ['drops an emptied value', { provider: '' }, 'other=kept'],
    [
      'writes numbers and booleans as text',
      { page: 2, search: true },
      'other=kept&page=2&provider=aws&search=true',
    ],
    ['treats false as cleared', { search: false }, 'other=kept&provider=aws'],
  ])('%s and leaves foreign keys alone', (_, changes, expected) => {
    const { result } = setup('/list?other=kept&provider=aws')
    act(() => result.current.update(changes))
    const params = new URLSearchParams(result.current.location.search)
    params.sort()
    expect(params.toString()).toBe(expected)
  })

  it('keeps the update function stable across renders', () => {
    const { result, rerender } = setup('/list')
    const first = result.current.update
    act(() => result.current.update({ search: 'x' }))
    rerender()
    expect(result.current.update).toBe(first)
    expect(result.current.values.search).toBe('x')
  })
})
