import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Pagination } from './Pagination'

function renderPagination(props: Partial<Parameters<typeof Pagination>[0]> = {}) {
  const onPageChange = vi.fn()
  const onPageSizeChange = vi.fn()
  render(
    <Pagination
      page={1}
      pageSize={25}
      total={60}
      pageSizeOptions={[25, 50, 100]}
      onPageChange={onPageChange}
      onPageSizeChange={onPageSizeChange}
      noun={['application', 'applications']}
      pageSizeLabel="Applications per page"
      {...props}
    />,
  )
  return { onPageChange, onPageSizeChange }
}

describe('Pagination', () => {
  it.each([
    [{ summary: 'pages' as const, page: 2, total: 30 }, 'Page 2 of 2 · 30 applications'],
    [{ summary: 'pages' as const, page: 1, total: 1 }, 'Page 1 of 1 · 1 application'],
    [{ summary: 'pages' as const, page: 1, total: 0 }, 'Page 1 of 1 · 0 applications'],
    [{ summary: 'range' as const, page: 1, total: 60 }, 'Showing 1–25 of 60 applications'],
    [{ summary: 'range' as const, page: 3, total: 60 }, 'Showing 51–60 of 60 applications'],
    [{ summary: 'range' as const, page: 1, total: 0 }, 'No applications'],
  ])('summarises %j as "%s"', (props, text) => {
    renderPagination(props)
    expect(screen.getByText(text)).toBeInTheDocument()
  })

  it('pages and resizes through its controls', async () => {
    const user = userEvent.setup()
    const { onPageChange, onPageSizeChange } = renderPagination({ page: 2 })

    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(onPageChange).toHaveBeenLastCalledWith(3)
    await user.click(screen.getByRole('button', { name: 'Previous' }))
    expect(onPageChange).toHaveBeenLastCalledWith(1)

    await user.selectOptions(screen.getByRole('combobox', { name: 'Applications per page' }), '50')
    expect(onPageSizeChange).toHaveBeenCalledWith(50)
  })

  it('disables the ends', () => {
    renderPagination({ page: 3, total: 60 })

    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled()
  })
})
