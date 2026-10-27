import { describe, expect, it } from 'vitest'
import { parseQuery, searchSummaries } from './search'
import type { Summary } from './imap'

const m = (uid: number, over: Partial<Summary> = {}): Summary => ({ uid, flags: [], internalDate: null, size: 1, from: { name: 'Alex Rivera', address: 'alex@brand.example' }, to: [{ name: 'Me', address: 'me@x.example' }], cc: [], subject: `Subject ${uid}`, messageId: `<${uid}@x>`, inReplyTo: null, references: [], date: uid, ...over })
const list = [
  m(1, { subject: 'Sponsorship offer for November', flags: ['\\Seen'] }),
  m(2, { subject: 'Invoice 4412 is overdue', from: { name: 'Billing', address: 'billing@tools.example' }, flags: ['\\Flagged'] }),
  m(3, { subject: 'Café plans', from: { name: 'José', address: 'jose@x.example' }, cc: [{ name: 'Boss', address: 'boss@x.example' }] })
]
const uids = (q: string, ctx = {}) => searchSummaries(list, q, ctx).map((x) => x.uid)

describe('searching the saved list', () => {
  it('matches words in the sender, recipients and subject, all of them, ignoring case and accents', () => {
    expect(uids('sponsorship')).toEqual([1])
    expect(uids('INVOICE overdue')).toEqual([2])
    expect(uids('cafe')).toEqual([3])
    expect(uids('jose')).toEqual([3])
    expect(uids('boss')).toEqual([3])
    expect(uids('invoice sponsorship')).toEqual([])
    expect(uids('')).toEqual([1, 2, 3])
  })

  it('narrows with operators', () => {
    expect(uids('from:billing')).toEqual([2])
    expect(uids('from:"alex rivera"')).toEqual([1])
    expect(uids('to:me')).toEqual([1, 2, 3])
    expect(uids('subject:plans')).toEqual([3])
    expect(uids('is:unread')).toEqual([2, 3])
    expect(uids('is:read')).toEqual([1])
    expect(uids('is:starred')).toEqual([2])
    expect(uids('from:alex is:unread')).toEqual([])
  })

  it('finds labelled messages', () => {
    const labelsOf = (x: Summary) => (x.uid === 1 ? ['Sponsors', 'Q4 deals'] : [])
    expect(uids('label:sponsors', { labelsOf })).toEqual([1])
    expect(uids('label:"q4 deals"', { labelsOf })).toEqual([1])
    expect(uids('label:taxes', { labelsOf })).toEqual([])
    expect(uids('label:sponsors', {})).toEqual([])
  })

  it('reads a query into its parts', () => {
    expect(parseQuery('from:alex "big deal" is:unread label:"q4 deals" plain')).toEqual({ words: ['big deal', 'plain'], from: ['alex'], to: [], subject: [], label: ['q4 deals'], unread: true })
  })
})
