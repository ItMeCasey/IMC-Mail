import { describe, expect, it } from 'vitest'
import { parseBackup, planImport, type Backup } from './backup'

const base = (over: Partial<Backup> = {}): Backup => ({
  app: 'IMC-Mail',
  version: 1,
  exportedAt: 1,
  labels: ['Taxes', 'Sponsors'],
  rules: [
    { name: 'Nova', enabled: true, match: { from: 'nova', to: '', subject: '', contains: '' }, actions: { labelName: 'Sponsors', category: 'sponsorship', markRead: false, star: false, archive: false } }
  ],
  savedSearches: [{ name: 'Unread Nova', query: 'from:nova is:unread' }],
  templates: [{ name: 'Rate card', subject: 'Rates', html: '<p>Hi</p>' }],
  ...over
})
const none = { labels: [], rules: [], savedSearchQueries: [], templates: [] }

describe('parseBackup', () => {
  it('accepts what it wrote, and fills in defaults for older, shorter files', () => {
    const r = parseBackup(JSON.stringify({ app: 'IMC-Mail', version: 1, exportedAt: 5 }))
    expect(r.ok && r.backup.labels).toEqual([])
    expect(parseBackup(JSON.stringify(base())).ok).toBe(true)
  })
  it('explains what is wrong with a file that is not one of ours', () => {
    expect(parseBackup('not json')).toEqual({ ok: false, error: expect.stringMatching(/not valid JSON/) })
    expect(parseBackup('{"hello":1}')).toEqual({ ok: false, error: expect.stringMatching(/not made by IMC-Mail/) })
    expect(parseBackup(JSON.stringify({ app: 'IMC-Mail', version: 2, exportedAt: 1 }))).toEqual({ ok: false, error: expect.stringMatching(/newer version/) })
  })
  it('refuses a rule that is out of range rather than importing half of it', () => {
    const bad = base()
    bad.rules[0]!.actions.category = 'nonsense' as never
    expect(parseBackup(JSON.stringify(bad)).ok).toBe(false)
  })
})

describe('planImport', () => {
  it('adds everything to an empty install', () => {
    const p = planImport(none, base())
    expect([p.labels.length, p.rules.length, p.savedSearches.length, p.templates.length, p.skipped]).toEqual([2, 1, 1, 1, 0])
  })
  it('skips what you already have (names ignoring case, searches by query) and counts it', () => {
    const p = planImport({ labels: ['taxes'], rules: ['NOVA'], savedSearchQueries: [' from:nova is:unread '], templates: ['rate card'] }, base())
    expect(p.labels).toEqual(['Sponsors'])
    expect([p.rules.length, p.savedSearches.length, p.templates.length]).toEqual([0, 0, 0])
    expect(p.skipped).toBe(4)
  })
  it('collapses duplicates inside the file, so importing twice adds nothing the second time', () => {
    const b = base({ labels: ['A', 'a', 'B'] })
    expect(planImport(none, b).labels).toEqual(['A', 'B'])
    const again = planImport({ labels: ['A', 'B'], rules: ['Nova'], savedSearchQueries: ['from:nova is:unread'], templates: ['Rate card'] }, b)
    expect(again.labels.length + again.rules.length + again.savedSearches.length + again.templates.length).toBe(0)
  })
})
