import { describe, expect, it } from 'vitest'
import { bodyCache, folderCache, itemStore, KEEP_BODIES, messageCache, migrate, outbox, phoneAdapters, syncStorage } from './phonedb'
import { memoryDb } from './test-db'
import { syncFolder } from './mailbox'
import { ImapClient, type Summary } from './imap'
import { FakeServer } from './fake-server'

const open = () => {
  const db = memoryDb()
  migrate(db)
  return db
}

const summary = (uid: number, over: Partial<Summary> = {}): Summary => ({
  uid,
  flags: [],
  internalDate: null,
  size: 100,
  from: { name: 'A', address: 'a@b.example' },
  to: [{ name: '', address: 'me@x.example' }],
  cc: [],
  subject: `Message ${uid}`,
  messageId: `<${uid}@x>`,
  inReplyTo: null,
  references: [],
  date: uid * 1000,
  ...over
})

describe('the database', () => {
  it('can be set up again and again, and upgrades a copy from before POP3', () => {
    const db = memoryDb()
    db.exec('CREATE TABLE message (account TEXT NOT NULL, folder TEXT NOT NULL, uid INTEGER NOT NULL, flags TEXT NOT NULL, internal_date TEXT, size INTEGER NOT NULL, from_json TEXT, to_json TEXT NOT NULL, cc_json TEXT NOT NULL, subject TEXT NOT NULL, message_id TEXT, in_reply_to TEXT, refs TEXT NOT NULL, date INTEGER, PRIMARY KEY (account, folder, uid))')
    db.run("INSERT INTO message VALUES ('a', 'inbox', 1, '[]', NULL, 5, NULL, '[]', '[]', 'Old', NULL, NULL, '[]', 1)")
    migrate(db)
    migrate(db)
    expect(db.all<{ name: string }>('PRAGMA table_info(message)').some((c) => c.name === 'remote_id')).toBe(true)
    expect(db.first<{ subject: string }>('SELECT subject FROM message')!.subject).toBe('Old')
  })
})

describe('saved message lists', () => {
  it('keeps messages newest first, with everything in a summary, and updates them in place', async () => {
    const db = open()
    const cache = messageCache(db)
    await cache.upsert('a', 'inbox', [summary(1), summary(3, { flags: ['\\Seen'], cc: [{ name: 'B', address: 'b@x' }], references: ['<r@x>'], remoteId: 'UIDL-3' }), summary(2)])
    expect((await cache.summaries('a', 'inbox')).map((m) => m.uid)).toEqual([3, 2, 1])
    const three = (await cache.summaries('a', 'inbox'))[0]!
    expect(three).toEqual(summary(3, { flags: ['\\Seen'], cc: [{ name: 'B', address: 'b@x' }], references: ['<r@x>'], remoteId: 'UIDL-3' }))
    await cache.upsert('a', 'inbox', [summary(3, { flags: [], subject: 'Renamed' })])
    expect((await cache.summaries('a', 'inbox'))[0]).toMatchObject({ subject: 'Renamed', flags: [] })
  })

  it('changes flags, removes messages with their bodies, and keeps accounts and folders apart', async () => {
    const db = open()
    const cache = messageCache(db)
    const bodies = bodyCache(db)
    await cache.upsert('a', 'inbox', [summary(1), summary(2)])
    await cache.upsert('b', 'inbox', [summary(1)])
    await cache.upsert('a', 'sent', [summary(1)])
    bodies.put('a', 'inbox', 1, { text: 'x', html: null, attachments: [], truncated: false })
    await cache.setFlags('a', 'inbox', new Map([[2, ['\\Seen', '\\Flagged']]]))
    expect((await cache.summaries('a', 'inbox')).find((m) => m.uid === 2)!.flags).toEqual(['\\Seen', '\\Flagged'])
    await cache.remove('a', 'inbox', [1])
    expect((await cache.summaries('a', 'inbox')).map((m) => m.uid)).toEqual([2])
    expect(bodies.get('a', 'inbox', 1)).toBeNull()
    expect((await cache.summaries('b', 'inbox')).length).toBe(1)
    expect((await cache.summaries('a', 'sent')).length).toBe(1)
    await cache.setFolderState('a', 'inbox', { uidValidity: 5, highestUid: 2, syncedAt: 9 })
    await cache.clear('a', 'inbox')
    expect(await cache.folderState('a', 'inbox')).toBeNull()
    expect((await cache.summaries('a', 'inbox')).length).toBe(0)
  })

  it('rolls back a batch that fails part way', async () => {
    const db = open()
    const cache = messageCache(db)
    await cache.upsert('a', 'inbox', [summary(1)])
    await expect(cache.upsert('a', 'inbox', [summary(2), { ...summary(3), subject: null as never }])).rejects.toThrow()
    expect((await cache.summaries('a', 'inbox')).map((m) => m.uid)).toEqual([1])
  })

  it('works as the saved copy for a real folder sync', async () => {
    const folder = { path: 'INBOX', uidValidity: 7, messages: [1, 2, 3].map((uid) => ({ uid, flags: uid === 1 ? ['\\Seen'] : [], raw: `From: A <a@b.example>\r\nSubject: S${uid}\r\nMessage-ID: <${uid}@x>\r\n\r\nbody` })) }
    const server = new FakeServer({ user: 'u', password: 'p', folders: [folder] })
    const client = new ImapClient(server.connect, { host: 'h', port: 993, security: 'tls', timeoutMs: 3000 })
    await client.open()
    await client.login('u', 'p')
    const cache = messageCache(open())
    expect(await syncFolder(client, cache, 'a', 'INBOX', { cacheKey: 'inbox' })).toMatchObject({ added: 3 })
    folder.messages.push({ uid: 4, flags: [], raw: 'From: A <a@b.example>\r\nSubject: S4\r\nMessage-ID: <4@x>\r\n\r\nbody' })
    folder.messages[1]!.flags = ['\\Seen']
    folder.messages.shift()
    expect(await syncFolder(client, cache, 'a', 'INBOX', { cacheKey: 'inbox' })).toMatchObject({ added: 1, removed: 1, flagsChanged: 1 })
    expect((await cache.summaries('a', 'inbox')).map((m) => [m.uid, m.flags.includes('\\Seen')])).toEqual([[4, false], [3, false], [2, true]])
  })
})

describe('message bodies', () => {
  it('saves and returns a body, and keeps only the most recent ones', () => {
    const db = open()
    let t = 0
    const bodies = bodyCache(db, () => ++t)
    const body = { text: 'hello', html: '<p>hello</p>', attachments: [{ filename: 'a.pdf', mimeType: 'application/pdf', size: 3, inline: false }], truncated: true }
    bodies.put('a', 'inbox', 1, body)
    expect(bodies.get('a', 'inbox', 1)).toEqual(body)
    expect(bodies.get('a', 'inbox', 2)).toBeNull()
    for (let uid = 2; uid <= KEEP_BODIES + 5; uid++) bodies.put('a', 'inbox', uid, { ...body, text: `m${uid}` })
    expect(db.first<{ n: number }>('SELECT COUNT(*) AS n FROM body')!.n).toBe(KEEP_BODIES)
    expect(bodies.get('a', 'inbox', 1)).toBeNull()
    expect(bodies.get('a', 'inbox', KEEP_BODIES + 5)!.text).toBe(`m${KEEP_BODIES + 5}`)
  })

  it('forgets everything about an account', async () => {
    const db = open()
    const cache = messageCache(db)
    const bodies = bodyCache(db)
    await cache.upsert('a', 'inbox', [summary(1)])
    await cache.upsert('b', 'inbox', [summary(1)])
    bodies.put('a', 'inbox', 1, { text: 'x', html: null, attachments: [], truncated: false })
    folderCache(db).set('a', [{ path: 'INBOX', name: 'INBOX', delimiter: '/', flags: [], specialUse: 'inbox', selectable: true }])
    bodies.forgetAccount('a')
    expect((await cache.summaries('a', 'inbox')).length).toBe(0)
    expect(bodies.get('a', 'inbox', 1)).toBeNull()
    expect(folderCache(db).get('a')).toEqual([])
    expect((await cache.summaries('b', 'inbox')).length).toBe(1)
  })
})

describe('folder lists', () => {
  it('keeps them in the order the server gave', () => {
    const f = folderCache(open())
    const list = [
      { path: 'INBOX', name: 'INBOX', delimiter: '/', flags: [], specialUse: 'inbox' as const, selectable: true },
      { path: 'Zeta', name: 'Zeta', delimiter: '/', flags: ['\\HasNoChildren'], specialUse: null, selectable: true },
      { path: '[Gmail]', name: '[Gmail]', delimiter: null, flags: ['\\Noselect'], specialUse: null, selectable: false }
    ]
    f.set('a', list)
    expect(f.get('a')).toEqual(list)
    f.set('a', list.slice(1))
    expect(f.get('a').map((x) => x.path)).toEqual(['Zeta', '[Gmail]'])
  })
})

describe('items from other devices', () => {
  it('stores each kind as it came, and lists them back', () => {
    const items = itemStore(open())
    items.put('label', 'l1', { name: 'Sponsors' })
    items.put('label', 'l2', { name: 'Taxes' })
    items.put('snooze', 'me@x\u001f<m@x>', { until: 5 })
    expect(items.list('label')).toEqual([{ id: 'l1', data: { name: 'Sponsors' } }, { id: 'l2', data: { name: 'Taxes' } }])
    expect(items.get('snooze', 'me@x\u001f<m@x>')).toEqual({ until: 5 })
    items.put('label', 'l1', { name: 'Renamed' })
    items.remove('label', 'l2')
    expect(items.list('label')).toEqual([{ id: 'l1', data: { name: 'Renamed' } }])
    expect(items.get('label', 'nope')).toBeNull()
  })

  it('checks what the adapters are given, whatever the kind', () => {
    const adapters = Object.fromEntries(phoneAdapters(open()).map((a) => [a.type, a]))
    expect(Object.keys(adapters).sort()).toEqual(['deal', 'followUp', 'label', 'meeting', 'messageLabel', 'pref', 'rule', 'savedSearch', 'snooze', 'template'])
    const label = adapters.label!
    expect(label.parse({ name: '' })).toBeNull()
    expect(label.upsert('l1', { name: 'Sponsors' })).toBe(true)
    expect(label.upsert('l2', { name: 5 })).toBe(false)
    expect(label.list()).toEqual([{ id: 'l1', data: { name: 'Sponsors' } }])
    label.remove('l1')
    expect(label.list()).toEqual([])
    expect(adapters.snooze!.upsert('a\u001fb', { until: 9 })).toBe(true)
    expect(adapters.followUp!.upsert('a\u001fb', { due: 9 })).toBe(false)
    expect(adapters.deal!.upsert('d1', { brand: 'Acme' })).toBe(false)
  })

  it('accepts the two preference items and nothing else under that kind', () => {
    const pref = phoneAdapters(open()).find((a) => a.type === 'pref')!
    const app = { streamerFeatures: true, showHolidays: true, holidayCountry: 'GB', meetingReminders: true, reminderLeadMinutes: 10, holidayReminders: false }
    expect(pref.parse(app)).not.toBeNull()
    expect(pref.upsert('app', app)).toBe(true)
    expect(pref.upsert('app', { ...app, holidayCountry: 'gb' })).toBe(false)
    expect(pref.upsert('notifications', { enabled: false })).toBe(false)
    expect(pref.upsert('notifications', { enabled: true, categories: ['sponsorship'], quietHours: { enabled: false, start: '22:00', end: '08:00' }, whenStreamSafe: 'silent' })).toBe(true)
    expect(pref.upsert('something', app)).toBe(false)
    expect(pref.list().map((x) => x.id)).toEqual(['app', 'notifications'])
  })
})

describe('sync bookkeeping', () => {
  it('keeps settings and item records, and clears them together', () => {
    const s = syncStorage(open())
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
  })
})

describe('settings of this phone', () => {
  it('start from defaults, keep what is changed, and keep small named values', async () => {
    const { phoneSettings, DEFAULT_PHONE_SETTINGS } = await import('./phonedb')
    const s = phoneSettings(open())
    expect(s.get()).toEqual(DEFAULT_PHONE_SETTINGS)
    expect(s.set({ privacyScreen: true })).toEqual({ ...DEFAULT_PHONE_SETTINGS, privacyScreen: true })
    expect(s.set({ hideNotificationDetails: true })).toMatchObject({ privacyScreen: true, hideNotificationDetails: true })
    expect(s.get().privacyScreen).toBe(true)
    expect(s.getValue('seen')).toBeNull()
    s.setValue('seen', '42')
    s.setValue('seen', '43')
    expect(s.getValue('seen')).toBe('43')
  })
})

describe('mail waiting to be sent', () => {
  it('keeps the exact bytes, in order, and marks a failure', () => {
    const box = outbox(open())
    const raw = Uint8Array.from({ length: 300 }, (_, i) => i & 255)
    box.add({ id: 'm2', account: 'a', sender: 'me@x', recipients: ['b@y'], raw, subject: 'Second', createdAt: 2 })
    box.add({ id: 'm1', account: 'a', sender: 'me@x', recipients: ['a@y', 'c@y'], raw: new Uint8Array([1, 2, 3]), subject: 'First', createdAt: 1 })
    box.add({ id: 'm3', account: 'other', sender: 'o@x', recipients: ['b@y'], raw: new Uint8Array([9]), subject: 'Theirs', createdAt: 3 })
    expect(box.list().map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
    expect([...box.list()[1]!.raw]).toEqual([...raw])
    expect(box.list()[0]).toMatchObject({ recipients: ['a@y', 'c@y'], error: null })
    box.fail('m1', 'No connection')
    expect(box.list()[0]!.error).toBe('No connection')
    box.remove('m1')
    box.forgetAccount('other')
    expect(box.list().map((m) => m.id)).toEqual(['m2'])
  })
})
