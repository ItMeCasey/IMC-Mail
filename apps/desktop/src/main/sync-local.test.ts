import { describe, expect, it } from 'vitest'
import { DEFAULT_NOTIFICATIONS } from './notifications'
import { openDb } from './db'
import { MailStore } from './store'
import { appPrefsSchema, sqliteSyncStorage, syncAdapters, type AppPrefs, type PrefsAccess } from './sync-local'
import { DeviceSync } from './sync'
import { SyncClient, type SyncAdapter } from '@imc/core'

const setup = () => {
  const db = openDb(':memory:')
  const store = new MailStore(db)
  const app: AppPrefs = { streamerFeatures: true, showHolidays: false, holidayCountry: 'US', meetingReminders: true, reminderLeadMinutes: 10, holidayReminders: false }
  const state = { app, notifications: DEFAULT_NOTIFICATIONS }
  const prefs: PrefsAccess = {
    getApp: () => state.app,
    setApp: (p) => void (state.app = p),
    getNotifications: () => state.notifications,
    setNotifications: (s) => void (state.notifications = s)
  }
  const adapters = syncAdapters(store, prefs)
  const by = (t: string): SyncAdapter => adapters.find((a) => a.type === t)!
  return { db, store, state, by }
}

describe('sync storage', () => {
  it('keeps settings and item records, and clears them together', () => {
    const { db } = setup()
    const s = sqliteSyncStorage(db)
    expect(s.get('server')).toBeNull()
    s.set('server', 'https://a')
    s.set('server', 'https://b')
    expect(s.get('server')).toBe('https://b')
    s.putItem({ type: 'label', id: 'l1', hash: 'h', hlc: '000000000000001-0000-dev', deleted: false })
    s.putItem({ type: 'label', id: 'l1', hash: 'h2', hlc: '000000000000002-0000-dev', deleted: true })
    s.putItem({ type: 'rule', id: 'r1', hash: 'x', hlc: '000000000000003-0000-dev', deleted: false })
    expect(s.item('label', 'l1')).toEqual({ type: 'label', id: 'l1', hash: 'h2', hlc: '000000000000002-0000-dev', deleted: true })
    expect(s.items('label')).toHaveLength(1)
    s.remove('server')
    expect(s.get('server')).toBeNull()
    s.clear()
    expect(s.items('rule')).toEqual([])
    expect(s.item('label', 'l1')).toBeNull()
  })
})

describe('labels', () => {
  it('creates, renames and removes a label under the id it came with', () => {
    const { store, by } = setup()
    const a = by('label')
    expect(a.upsert('id-1', a.parse({ name: ' Sponsors ' }))).toBe(true)
    expect(a.list()).toEqual([{ id: 'id-1', data: { name: 'Sponsors' } }])
    expect(a.upsert('id-1', a.parse({ name: 'Brand deals' }))).toBe(true)
    expect(store.listLabels().map((l) => [l.id, l.name])).toEqual([['id-1', 'Brand deals']])
    a.remove('id-1')
    expect(a.list()).toEqual([])
  })

  it('does not store a label whose name another label already has', () => {
    const { store, by } = setup()
    store.createLabel('Taxes')
    expect(by('label').upsert('other-id', { name: 'taxes' })).toBe(false)
    expect(store.listLabels()).toHaveLength(1)
  })

  it('rejects contents that are not a name', () => {
    const { by } = setup()
    expect(by('label').parse({ name: '' })).toBeNull()
    expect(by('label').parse({ name: 5 })).toBeNull()
    expect(by('label').parse('x')).toBeNull()
  })
})

describe('rules and saved searches', () => {
  it('round-trips a rule', () => {
    const { by, store } = setup()
    const rule = { name: 'Sponsor mail', enabled: true, match: { from: 'brand.com' }, actions: { markRead: true } }
    const a = by('rule')
    const parsed = a.parse(rule)
    expect(parsed).not.toBeNull()
    a.upsert('rule-1', parsed)
    expect(store.listRules()[0]).toMatchObject({ id: 'rule-1', name: 'Sponsor mail', enabled: true })
    a.upsert('rule-1', a.parse({ ...rule, enabled: false }))
    expect(store.listRules()).toHaveLength(1)
    expect(a.list()[0]!.data).toMatchObject({ enabled: false })
    a.remove('rule-1')
    expect(store.listRules()).toEqual([])
  })

  it('rejects a rule that is not shaped like one', () => {
    expect(setup().by('rule').parse({ name: 'x', enabled: 'yes' })).toBeNull()
  })

  it('round-trips a saved search by id', () => {
    const { by, store } = setup()
    const a = by('savedSearch')
    a.upsert('s1', a.parse({ name: 'Unpaid', query: 'invoice unpaid' }))
    a.upsert('s1', a.parse({ name: 'Unpaid invoices', query: 'invoice unpaid' }))
    expect(store.listSavedSearches()).toEqual([{ id: 's1', name: 'Unpaid invoices', query: 'invoice unpaid' }])
    a.remove('s1')
    expect(store.listSavedSearches()).toEqual([])
  })
})

describe('templates', () => {
  it('syncs the words but not the attached files, and keeps the files already here', () => {
    const { by, store } = setup()
    const a = by('template')
    a.upsert('t1', a.parse({ name: 'Rates', subject: 'Re: {{brand}}', html: '<p>Hello</p>' }))
    const have = store.listTemplates()[0]!
    expect(have.attachments).toEqual([])
    store.putTemplate({ ...have, attachments: [{ path: 'C:\\kit.pdf', name: 'kit.pdf', size: 10 } as never] })
    expect(a.list()[0]!.data).toEqual({ name: 'Rates', subject: 'Re: {{brand}}', html: '<p>Hello</p>' })
    a.upsert('t1', a.parse({ name: 'Rates 2', subject: '', html: '<p>Hi</p>' }))
    const after = store.listTemplates()[0]!
    expect(after.name).toBe('Rates 2')
    expect(after.attachments).toHaveLength(1)
  })
})

describe('preferences', () => {
  it('applies valid app choices and notification settings, and refuses others', () => {
    const { by, state } = setup()
    const a = by('pref')
    expect(a.list().map((e) => e.id)).toEqual(['app', 'notifications'])
    const next = { ...state.app, showHolidays: true, holidayCountry: 'GB', reminderLeadMinutes: 30 }
    expect(a.upsert('app', a.parse(next))).toBe(true)
    expect(state.app).toEqual(next)
    expect(a.upsert('app', { ...next, holidayCountry: 'gb' })).toBe(false)
    expect(a.upsert('app', { ...next, closeToTray: true, reminderLeadMinutes: 999 })).toBe(false)
    expect(state.app.reminderLeadMinutes).toBe(30)
    expect(a.upsert('notifications', { ...DEFAULT_NOTIFICATIONS, enabled: false })).toBe(true)
    expect(state.notifications.enabled).toBe(false)
    expect(a.upsert('notifications', { enabled: 'no' })).toBe(false)
    expect(a.upsert('something else', {})).toBe(false)
  })

  it('leaves out window behavior that belongs to one computer', () => {
    expect(Object.keys(appPrefsSchema.shape)).not.toContain('closeToTray')
  })
})

describe('the sync service', () => {
  it('makes a QR image of the pairing code, and does nothing to sync until paired', async () => {
    const { db, by } = setup()
    const svc = new DeviceSync({ storage: sqliteSyncStorage(db), secrets: { get: async () => undefined, set: async () => {}, delete: async () => {} }, adapters: [by('label')], onApplied: () => {} })
    expect(svc.client).toBeInstanceOf(SyncClient)
    expect(svc.client.status().paired).toBe(false)
    svc.syncSoon() // no timer is set while not paired
    const v = await svc.view({ server: 'https://sync.test', groupId: 'g'.repeat(22), key: 'k'.repeat(43) })
    expect(v.code.startsWith('imcsync1:')).toBe(true)
    expect(v.qr).toMatch(/^data:image\/png;base64,/)
    svc.stop()
  })
})

// ---- things that belong to an account or a message ---------------------------------------------------------
// Two devices, each with its own local ids, that know the same account by its address.

const deviceWith = (email: string, opts: { mail?: boolean } = {}) => {
  const db = openDb(':memory:')
  const store = new MailStore(db)
  const state = { app: {} as AppPrefs, notifications: DEFAULT_NOTIFICATIONS }
  const adapters = syncAdapters(store, { getApp: () => state.app, setApp: () => {}, getNotifications: () => state.notifications, setNotifications: () => {} })
  const account = store.addAccount({ email, username: email, imap: { host: 'h', port: 993, security: 'tls' }, smtp: { host: 'h', port: 465, security: 'tls' } }, 'imap').id
  const inbox = store.upsertFolder(account, { path: 'INBOX', name: 'Inbox', role: 'inbox' })
  const msg = (uid: number, rfc: string) => ({ uid, messageId: rfc, fromName: 'A', fromAddr: 'a@b.example', to: email, subject: `s${uid}`, date: uid, flags: [], refs: [] })
  if (opts.mail !== false) store.applyFetched(account, inbox, [msg(1, '<one@x>'), msg(2, '<two@x>')], null)
  const by = (t: string): SyncAdapter => adapters.find((a) => a.type === t)!
  const localId = (rfc: string) => store.messageIdForRfc(account, rfc)!
  return { db, store, account, by, localId }
}

/** What device `to` ends up doing with everything device `from` has of one kind. */
const transfer = (from: ReturnType<typeof deviceWith>, to: ReturnType<typeof deviceWith>, type: string) =>
  from.by(type).list().map((e) => ({ id: e.id, result: to.by(type).upsert(e.id, to.by(type).parse(e.data)) }))

describe('deals', () => {
  const makeDeal = (d: ReturnType<typeof deviceWith>) => d.store.createDeal({ accountId: d.account, messageId: d.localId('<one@x>'), brand: 'Acme', rate: 500, stage: 'negotiating', dueDate: 1_800_000_000_000, notes: 'Net 30' })

  it('arrives on a device that has the same account, linked to the same message', () => {
    const a = deviceWith('Me@Example.com')
    const b = deviceWith('me@example.com')
    const deal = makeDeal(a)
    expect(transfer(a, b, 'deal')).toEqual([{ id: deal.id, result: true }])
    const got = b.store.getDeal(deal.id)!
    expect(got).toMatchObject({ accountId: b.account, messageId: b.localId('<one@x>'), brand: 'Acme', stage: 'negotiating', rate: 500, notes: 'Net 30' })
    expect(got.updatedAt).toBe(deal.updatedAt)
    expect(a.by('deal').list()[0]!.data).toMatchObject({ account: 'me@example.com', rfcId: '<one@x>' })
  })

  it('waits while the account is not on this device, and does not invent one', () => {
    const a = deviceWith('me@example.com')
    const other = deviceWith('someone@else.example')
    makeDeal(a)
    expect(transfer(a, other, 'deal')[0]!.result).toBe('later')
    expect(other.store.listDeals()).toEqual([])
  })

  it('keeps the deal when its message has not been downloaded here, and keeps a link it already has', () => {
    const a = deviceWith('me@example.com')
    const b = deviceWith('me@example.com', { mail: false })
    const deal = makeDeal(a)
    expect(transfer(a, b, 'deal')[0]!.result).toBe(true)
    expect(b.store.getDeal(deal.id)!.messageId).toBeNull()

    const c = deviceWith('me@example.com')
    transfer(a, c, 'deal')
    expect(c.store.getDeal(deal.id)!.messageId).toBe(c.localId('<one@x>'))
    a.store.updateDeal(deal.id, { stage: 'paid' })
    // The message is not found on c any more, but the link it already has survives the update.
    c.db.pragma('foreign_keys = OFF')
    c.db.prepare('DELETE FROM message WHERE message_id = ?').run('<one@x>')
    const linked = c.store.getDeal(deal.id)!.messageId
    expect(transfer(a, c, 'deal')[0]!.result).toBe(true)
    expect(c.store.getDeal(deal.id)).toMatchObject({ stage: 'paid', messageId: linked })
  })

  it('removes a deal, and refuses a malformed one', () => {
    const a = deviceWith('me@example.com')
    const deal = makeDeal(a)
    a.by('deal').remove(deal.id)
    expect(a.store.listDeals()).toEqual([])
    expect(a.by('deal').parse({ account: 'me@example.com', brand: '', stage: 'lead' })).toBeNull()
    expect(a.by('deal').parse({ account: 'me@example.com', rfcId: null, brand: 'X', stage: 'bogus', rate: null, currency: 'USD', deliverables: '', dueDate: null, notes: '', createdAt: 1, updatedAt: 1, paidAt: null })).toBeNull()
  })
})

describe('labels on messages', () => {
  it('puts a label on the same message on another device, once the label itself is there', () => {
    const a = deviceWith('me@example.com')
    const b = deviceWith('me@example.com')
    const label = a.store.createLabel('Sponsors')
    a.store.setLabels(a.localId('<one@x>'), [label.id])
    // The label has not arrived yet: the assignment waits.
    expect(transfer(a, b, 'messageLabel')[0]!.result).toBe('later')
    expect(b.store.labelIdsOf(b.localId('<one@x>'))).toEqual([])
    transfer(a, b, 'label')
    expect(transfer(a, b, 'messageLabel')[0]!.result).toBe(true)
    expect(b.store.labelIdsOf(b.localId('<one@x>'))).toEqual([label.id])
    // Taking it off the message is a removal.
    const id = a.by('messageLabel').list()[0]!.id
    b.by('messageLabel').remove(id)
    expect(b.store.labelIdsOf(b.localId('<one@x>'))).toEqual([])
  })

  it('does not sync a label whose key would be too long', () => {
    const a = deviceWith('me@example.com')
    const label = a.store.createLabel('X')
    a.db.prepare('INSERT INTO message_label (account_id, rfc_id, label_id) VALUES (?, ?, ?)').run(a.account, `<${'x'.repeat(300)}@x>`, label.id)
    expect(a.by('messageLabel').list()).toEqual([])
  })
})

describe('snoozes and follow-ups', () => {
  it('snooze the same message on another device, and wake it there', () => {
    const a = deviceWith('me@example.com')
    const b = deviceWith('me@example.com')
    a.store.snooze(a.localId('<one@x>'), 1_900_000_000_000)
    expect(transfer(a, b, 'snooze')[0]!.result).toBe(true)
    expect(b.store.snoozedUntil(b.localId('<one@x>'))).toBe(1_900_000_000_000)
    const id = a.by('snooze').list()[0]!.id
    b.by('snooze').remove(id)
    expect(b.store.snoozedUntil(b.localId('<one@x>'))).toBeNull()
  })

  it('waits for a message that is not downloaded here yet', () => {
    const a = deviceWith('me@example.com')
    const b = deviceWith('me@example.com', { mail: false })
    a.store.snooze(a.localId('<two@x>'), 1_900_000_000_000)
    a.store.setFollowUp(a.localId('<two@x>'), 1_900_000_000_000)
    expect(transfer(a, b, 'snooze')[0]!.result).toBe('later')
    expect(transfer(a, b, 'followUp')[0]!.result).toBe('later')
  })

  it('carries a follow-up with whether it has already been shown', () => {
    const a = deviceWith('me@example.com')
    const b = deviceWith('me@example.com')
    a.store.setFollowUp(a.localId('<one@x>'), 1_800_000_000_000)
    a.db.prepare('UPDATE followup SET fired = 1').run()
    expect(a.by('followUp').list()[0]!.data).toEqual({ due: 1_800_000_000_000, fired: true })
    transfer(a, b, 'followUp')
    expect(b.store.followUpRows()).toEqual([{ email: 'me@example.com', rfcId: '<one@x>', due: 1_800_000_000_000, fired: true }])
    b.by('followUp').remove(a.by('followUp').list()[0]!.id)
    expect(b.store.followUpRows()).toEqual([])
  })
})

describe('meetings', () => {
  const meeting = (account: string, over: Record<string, unknown> = {}) => ({
    id: 'local-1',
    accountId: account,
    uid: 'uid-1@example.com',
    recurrenceId: null,
    sequence: 1,
    summary: 'Sponsor call',
    description: 'Rates',
    location: 'Zoom',
    start: 1_800_000_000_000,
    end: 1_800_003_600_000,
    allDay: false,
    rrule: null,
    exdates: [],
    organizer: { name: 'Brand', email: 'pm@brand.example' },
    attendees: [],
    status: 'CONFIRMED' as const,
    onlineUrl: null,
    free: false,
    myResponse: 'accepted' as const,
    mine: false,
    repeats: null,
    messageId: null,
    updatedAt: 5,
    ...over
  })

  it("brings a meeting and your answer to it to another device, under that device's own id", () => {
    const a = deviceWith('me@example.com')
    const b = deviceWith('me@example.com')
    a.store.putEvent(meeting(a.account) as never)
    expect(transfer(a, b, 'meeting')[0]!.result).toBe(true)
    const got = b.store.allEvents()
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ uid: 'uid-1@example.com', summary: 'Sponsor call', myResponse: 'accepted', accountId: b.account })
    expect(got[0]!.id).not.toBe('local-1')
  })

  it('updates the same meeting when your answer changes, and removes it when it is cancelled', () => {
    const a = deviceWith('me@example.com')
    const b = deviceWith('me@example.com')
    a.store.putEvent(meeting(a.account) as never)
    transfer(a, b, 'meeting')
    a.store.putEvent(meeting(a.account, { myResponse: 'declined' }) as never)
    transfer(a, b, 'meeting')
    expect(b.store.allEvents()).toHaveLength(1)
    expect(b.store.allEvents()[0]!.myResponse).toBe('declined')
    b.by('meeting').remove(a.by('meeting').list()[0]!.id)
    expect(b.store.allEvents()).toEqual([])
  })

  it('does not replace a newer version of a meeting that arrived here by email', () => {
    const a = deviceWith('me@example.com')
    const b = deviceWith('me@example.com')
    a.store.putEvent(meeting(a.account, { sequence: 1, summary: 'Old title' }) as never)
    b.store.putEvent(meeting(b.account, { id: 'local-b', sequence: 3, summary: 'New title' }) as never)
    expect(transfer(a, b, 'meeting')[0]!.result).toBe(false)
    expect(b.store.allEvents()[0]!.summary).toBe('New title')
  })

  it('keeps one occurrence of a series apart from the series', () => {
    const a = deviceWith('me@example.com')
    a.store.putEvent(meeting(a.account, { rrule: 'FREQ=WEEKLY' }) as never)
    a.store.putEvent(meeting(a.account, { id: 'local-2', recurrenceId: 1_800_604_800_000, summary: 'Moved' }) as never)
    const ids = a.by('meeting').list().map((e) => e.id)
    expect(new Set(ids).size).toBe(2)
    const b = deviceWith('me@example.com')
    transfer(a, b, 'meeting')
    expect(b.store.allEvents().map((e) => e.summary).sort()).toEqual(['Moved', 'Sponsor call'])
  })

  it('rejects a meeting that is not shaped like one', () => {
    expect(deviceWith('me@example.com').by('meeting').parse({ summary: 'x' })).toBeNull()
  })
})
