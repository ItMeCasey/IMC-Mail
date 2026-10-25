import { describe, expect, it } from 'vitest'
import { csvField, dealsToCsv } from './csv'
import type { Deal } from './schemas'

const deal = (over: Partial<Deal>): Deal => ({
  id: 'd', accountId: 'a', messageId: null, brand: 'Nova', stage: 'paid', rate: 4000, currency: 'USD',
  deliverables: '2 videos', dueDate: Date.UTC(2026, 10, 4), notes: '', createdAt: Date.UTC(2026, 9, 1),
  updatedAt: 0, paidAt: Date.UTC(2026, 10, 20), ...over
})

describe('csvField', () => {
  it('quotes commas, quotes and line breaks', () => {
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('x\ny')).toBe('"x\ny"')
    expect(csvField('plain')).toBe('plain')
  })
  it('keeps numbers and blanks, and defuses formulas', () => {
    expect(csvField(4000)).toBe('4000')
    expect(csvField(null)).toBe('')
    expect(csvField('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`)
    expect(csvField('+1 555')).toBe("'+1 555")
    expect(csvField('@sum')).toBe("'@sum")
  })
})

describe('dealsToCsv', () => {
  it('writes a header and one row per deal, oldest first, with readable stages and ISO dates', () => {
    const csv = dealsToCsv([
      deal({ id: 'b', brand: 'Late, Inc', stage: 'lead', rate: null, dueDate: null, paidAt: null, createdAt: Date.UTC(2026, 9, 5) }),
      deal({})
    ])
    expect(csv.split('\r\n')).toEqual([
      'Brand,Stage,Rate,Currency,Deliverables,Due date,Paid on,Created,Notes',
      'Nova,Paid,4000,USD,2 videos,2026-11-04,2026-11-20,2026-10-01,',
      '"Late, Inc",Lead,,USD,2 videos,,,2026-10-05,',
      ''
    ])
  })
})
