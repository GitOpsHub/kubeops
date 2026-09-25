import type { ReactNode } from 'react'

/** The screen-reader twin of a chart: every value, no colour needed. */
export function ChartTable({
  caption,
  headers,
  rows,
}: {
  caption: string
  headers: string[]
  rows: ReactNode[][]
}) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          {headers.map((header) => (
            <th key={header} scope="col">
              {header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((cells, row) => (
          <tr key={row}>
            {cells.map((cell, column) =>
              column === 0 ? (
                <th key={column} scope="row">
                  {cell}
                </th>
              ) : (
                <td key={column}>{cell}</td>
              ),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
