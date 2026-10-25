import { DEAL_STAGES, type Deal } from './schemas'

/**
 * One CSV field. Quotes anything with a comma, quote or line break, and defuses values a
 * spreadsheet would run as a formula (a leading = + - @ or tab) by prefixing an apostrophe.
 */
export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  let s = String(value)
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const date = (ms: number | null): string => (ms === null ? '' : new Date(ms).toISOString().slice(0, 10))

export const DEAL_CSV_HEADER = [
  'Brand',
  'Stage',
  'Rate',
  'Currency',
  'Deliverables',
  'Due date',
  'Paid on',
  'Created',
  'Notes'
] as const

/** Every deal as CSV (CRLF line ends, UTF-8 BOM added by the writer) for a spreadsheet or an accountant. */
export function dealsToCsv(deals: Deal[]): string {
  const label = new Map(DEAL_STAGES.map((s) => [s.id, s.label]))
  const rows = [...deals]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((d) =>
      [
        d.brand,
        label.get(d.stage) ?? d.stage,
        d.rate,
        d.currency,
        d.deliverables,
        date(d.dueDate),
        date(d.paidAt),
        date(d.createdAt),
        d.notes
      ]
        .map(csvField)
        .join(',')
    )
  return [DEAL_CSV_HEADER.join(','), ...rows].join('\r\n') + '\r\n'
}
