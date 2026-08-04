/**
 * Shared CSV export helper.
 *
 * Triggers a client-side download of a CSV built from a header row + data rows.
 * Cells are quoted and any `"` doubled per RFC 4180; cells that begin with a
 * formula-trigger character (`= + - @` tab/CR) are prefixed with a single quote
 * so spreadsheet apps can't execute them (CSV-injection defense).
 *
 * Lifted from the margin dashboard so every list page can export the same way.
 */
export type CsvCell = string | number | null | undefined

export function toCsv(headers: string[], rows: CsvCell[][]): string {
  const cell = (c: CsvCell) => {
    let s = String(c ?? '')
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
    return `"${s.replace(/"/g, '""')}"`
  }
  return [headers, ...rows].map(r => r.map(cell).join(',')).join('\n')
}

export function downloadCSV(filename: string, headers: string[], rows: CsvCell[][]): void {
  const csv = toCsv(headers, rows)
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
