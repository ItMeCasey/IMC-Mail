import { beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from './db'
import { RuleEngine } from './rules'
import { MailStore, type FetchedMessage } from './store'

const m = (uid: number, over: Partial<FetchedMessage> = {}): FetchedMessage => ({
  uid, messageId: `<m${uid}@x>`, fromName: 'Nova Energy', fromAddr: 'partners@nova.example', to: 'me@x.example',
  subject: `Brief ${uid}`, date: uid, flags: [], refs: [], ...over
})
const rule = (over: Record<string, unknown> = {}) => ({
  name: 'Nova', enabled: true,
  match: { from: 'nova', to: '', subject: '', contains: '' },
  actions: { labelId: null, category: null, markRead: false, star: false, archive: false },
  ...over
}) as Parameters<MailStore['saveRule']>[0]

describe('saved searches', () => {
  it('saves, lists in order, renames a repeat of the same query, and deletes', () => {
    const store = new MailStore(Object.assign(new Database(':memory:'), {}))
    migrate((store as unknown as { db: Database.Database }).db)
    const a = store.saveSearch('Unread from Nova', 'from:nova is:unread', 1)
    store.saveSearch('Invoices', 'category:invoice', 2)
    expect(store.listSavedSearches().map((s) => s.name)).toEqual(['Unread from Nova', 'Invoices'])
    expect(store.saveSearch('Nova unread', 'from:nova is:unread', 3).id).toBe(a.id)
    expect(store.listSavedSearches().map((s) => s.name)).toEqual(['Nova unread', 'Invoices'])
    store.deleteSavedSearch(a.id)
    expect(store.listSavedSearches()).toHaveLength(1)
  })
})

describe('rules', () => {
  let store: MailStore
  let acct: string
  let inbox: string
  let sentBox: string
  const setFlags = vi.fn(async () => {})
  const archive = vi.fn(async () => {})
  let engine: RuleEngine

  beforeEach(() => {
    setFlags.mockClear(); archive.mockClear()
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    store = new MailStore(db)
    acct = store.addAccount({ email: 'me@x.example', username: 'me', imap: { host: 'h', port: 993, security: 'tls' }, smtp: { host: 'h', port: 465, security: 'tls' } }, 'imap').id
    inbox = store.upsertFolder(acct, { path: 'INBOX', name: 'Inbox', role: 'inbox' })
    sentBox = store.upsertFolder(acct, { path: 'Sent', name: 'Sent', role: 'sent' })
    store.applyFetched(acct, inbox, [m(1), m(2, { fromName: 'Dana', fromAddr: 'dana@y.example' })], null)
    store.applyFetched(acct, sentBox, [m(3)], null)
    engine = new RuleEngine(store, { setFlags, archive })
  })
  const id = (uid: number) => `${inbox}:${uid}`

  it('saves, edits, toggles and deletes rules', () => {
    const r = store.saveRule(rule())
    expect(store.listRules()).toEqual([r])
    store.saveRule({ ...r, enabled: false, name: 'Renamed' })
    expect(store.listRules()[0]).toMatchObject({ id: r.id, name: 'Renamed', enabled: false })
    store.deleteRule(r.id)
    expect(store.listRules()).toEqual([])
  })

  it('labels, categorizes, stars and marks read only the messages that match', async () => {
    const tag = store.createLabel('Sponsors')
    store.saveRule(rule({ actions: { labelId: tag.id, category: 'sponsorship', markRead: true, star: true, archive: false } }))
    expect(await engine.apply([id(1), id(2)])).toBe(1)
    expect(store.labelIdsOf(id(1))).toEqual([tag.id])
    expect(store.labelIdsOf(id(2))).toEqual([])
    expect(store.getMessage(id(1))?.categoryManual).toBe('sponsorship')
    expect(setFlags).toHaveBeenCalledTimes(1)
    expect(setFlags).toHaveBeenCalledWith(id(1), { seen: true, flagged: true })
  })

  it('keeps labels you already had, ignores disabled rules, and only touches the inbox', async () => {
    const a = store.createLabel('Keep')
    const b = store.createLabel('Add')
    store.setLabels(id(1), [a.id])
    store.saveRule(rule({ actions: { labelId: b.id, category: null, markRead: false, star: false, archive: false } }))
    store.saveRule(rule({ name: 'off', enabled: false, actions: { labelId: null, category: null, markRead: true, star: false, archive: false } }))
    await engine.apply([id(1), `${sentBox}:3`])
    expect(store.labelIdsOf(id(1)).sort()).toEqual([a.id, b.id].sort())
    expect(setFlags).not.toHaveBeenCalled()
    expect(store.labelIdsOf(`${sentBox}:3`)).toEqual([])
  })

  it('archives, then stops running later rules on that message; a refused archive does not stop the rest', async () => {
    store.saveRule(rule({ name: 'first', actions: { labelId: null, category: null, markRead: false, star: false, archive: true } }))
    store.saveRule(rule({ name: 'second', actions: { labelId: null, category: null, markRead: true, star: false, archive: false } }))
    await engine.apply([id(1)])
    expect(archive).toHaveBeenCalledWith(id(1))
    expect(setFlags).not.toHaveBeenCalled()
    archive.mockRejectedValueOnce(new Error('offline'))
    await engine.apply([id(1)])
    expect(setFlags).toHaveBeenCalledTimes(1)
  })

  it('runs one rule over existing mail when asked', async () => {
    const r = store.saveRule(rule({ actions: { labelId: null, category: 'collab', markRead: false, star: false, archive: false } }))
    store.saveRule(rule({ name: 'other', match: { from: 'dana', to: '', subject: '', contains: '' }, actions: { labelId: null, category: 'fan', markRead: false, star: false, archive: false } }))
    expect(await engine.apply(store.recentInboxIds(500), r.id)).toBe(1)
    expect(store.getMessage(id(1))?.categoryManual).toBe('collab')
    expect(store.getMessage(id(2))?.categoryManual).toBeNull()
  })
})
