import { beforeEach, describe, expect, it } from 'vitest'
import { SyncClient, syncKey, type SyncAdapter, type SyncItem, type SyncSecrets, type SyncStorage, type SyncType } from '@imc/core'
import { itemStore, migrate, phoneAdapters, syncStorage } from '@imc/mail'
import { memoryDb } from '@imc/mail/test-db'
import { handle, Limiter, type Deps } from './app'
import { SyncStore } from './store'

// The phone's real storage and adapters syncing with a device that keeps things in memory, through the real server logic.

const SERVER = 'https://sync.test'
let clock: { t: number }
let deps: Deps

beforeEach(() => {
  clock = { t: Date.UTC(2026, 9, 26, 12, 0, 0) }
  deps = { store: new SyncStore(':memory:'), limiter: new Limiter(() => clock.t), now: () => clock.t }
})

const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
  const headers = (init?.headers ?? {}) as Record<string, string>
  const out = await handle({ method: init?.method ?? 'GET', path: new URL(String(url)).pathname, authorization: headers['Authorization'], ip: '1.1.1.1', bodyText: String(init?.body ?? '') }, deps)
  return new Response(JSON.stringify(out.json), { status: out.status })
}) as typeof fetch

function memoryStorage(): SyncStorage {
  const kv = new Map<string, string>()
  const all = new Map<string, SyncItem>()
  return {
    get: (k) => kv.get(k) ?? null,
    set: (k, v) => void kv.set(k, v),
    remove: (k) => void kv.delete(k),
    item: (t, id) => all.get(`${t}:${id}`) ?? null,
    items: (t) => [...all.values()].filter((i) => i.type === t),
    putItem: (i) => void all.set(`${i.type}:${i.id}`, i),
    clear: () => (kv.clear(), all.clear())
  }
}

const secrets = (): SyncSecrets => {
  const m = new Map<string, string>()
  return { get: async (k) => m.get(k), set: async (k, v) => void m.set(k, v), delete: async (k) => void m.delete(k) }
}

/** A device that keeps every kind of item in memory without checking it: the desktop's role. */
function plainDevice() {
  const data = new Map<string, Map<string, unknown>>()
  const adapters: SyncAdapter[] = ['label', 'deal', 'snooze', 'followUp', 'meeting', 'pref', 'messageLabel'].map((t) => {
    const rows = new Map<string, unknown>()
    data.set(t, rows)
    return { type: t as SyncType, list: () => [...rows].map(([id, d]) => ({ id, data: d })), parse: (d) => d, upsert: (id, d) => (rows.set(id, d), true), remove: (id) => void rows.delete(id) }
  })
  return { rows: (t: string) => data.get(t)!, client: new SyncClient({ storage: memoryStorage(), secrets: secrets(), adapters, fetchFn, now: () => clock.t }) }
}

function phoneDevice() {
  const db = memoryDb()
  migrate(db)
  return { db, items: itemStore(db), client: new SyncClient({ storage: syncStorage(db), secrets: secrets(), adapters: phoneAdapters(db), fetchFn, now: () => clock.t }) }
}

const deal = { account: 'me@example.com', rfcId: '<m1@brand>', brand: 'Acme', stage: 'negotiating', rate: 500, currency: 'USD', deliverables: '2 videos', dueDate: 1_800_000_000_000, notes: 'Net 30', createdAt: 1, updatedAt: 2, paidAt: null }
const meeting = { sequence: 1, summary: 'Sponsor call', description: '', location: 'Zoom', start: 1_800_000_000_000, end: 1_800_003_600_000, allDay: false, rrule: null, exdates: [], organizer: null, attendees: [], status: 'CONFIRMED', onlineUrl: null, myResponse: 'accepted', mine: false, free: false }
const tick = () => (clock.t += 1000)

async function pair() {
  const desktop = plainDevice()
  const phone = phoneDevice()
  const p = await desktop.client.enable(SERVER, 'Desktop')
  tick()
  await phone.client.join(desktop.client.pairingCode(p), 'Phone')
  return { desktop, phone }
}

describe('the phone syncing with another device', () => {
  it('receives every kind of item from the desktop, keyed by account and message', async () => {
    const { desktop, phone } = await pair()
    const snoozeKey = syncKey('me@example.com', '<m1@brand>')!
    desktop.rows('label').set('l1', { name: 'Sponsors' })
    desktop.rows('deal').set('d1', deal)
    desktop.rows('snooze').set(snoozeKey, { until: 1_900_000_000_000 })
    desktop.rows('followUp').set(snoozeKey, { due: 1_900_000_000_000, fired: false })
    desktop.rows('meeting').set(syncKey('me@example.com', 'uid-1@x', '')!, meeting)
    desktop.rows('messageLabel').set(syncKey('me@example.com', '<m1@brand>', 'l1')!, { on: true })
    await desktop.client.syncNow()
    expect((await phone.client.syncNow()).error).toBeNull()
    expect(phone.items.list('label')).toEqual([{ id: 'l1', data: { name: 'Sponsors' } }])
    expect(phone.items.get('deal', 'd1')).toMatchObject({ brand: 'Acme', stage: 'negotiating', rfcId: '<m1@brand>' })
    expect(phone.items.get('snooze', snoozeKey)).toEqual({ until: 1_900_000_000_000 })
    expect(phone.items.get('followUp', snoozeKey)).toEqual({ due: 1_900_000_000_000, fired: false })
    expect(phone.items.list('meeting')).toHaveLength(1)
    expect(phone.items.list('messageLabel')).toHaveLength(1)
  })

  it('takes preferences, and leaves out an item that is not valid', async () => {
    const { desktop, phone } = await pair()
    const app = { streamerFeatures: false, showHolidays: true, holidayCountry: 'GB', meetingReminders: true, reminderLeadMinutes: 15, holidayReminders: false }
    desktop.rows('pref').set('app', app)
    desktop.rows('pref').set('something else', { x: 1 })
    desktop.rows('deal').set('bad', { brand: '' })
    desktop.rows('deal').set('good', deal)
    await desktop.client.syncNow()
    expect((await phone.client.syncNow()).error).toBeNull()
    expect(phone.items.get('pref', 'app')).toEqual(app)
    expect(phone.items.list('pref').map((x) => x.id)).toEqual(['app'])
    expect(phone.items.list('deal').map((x) => x.id)).toEqual(['good'])
  })

  it('sends what the phone itself changes, and a deletion', async () => {
    const { desktop, phone } = await pair()
    desktop.rows('label').set('l1', { name: 'Sponsors' })
    desktop.rows('label').set('l2', { name: 'Taxes' })
    await desktop.client.syncNow()
    await phone.client.syncNow()
    // On the phone: snooze a message, rename a label, remove one.
    tick()
    phone.items.put('snooze', syncKey('me@example.com', '<x@y>')!, { until: 123 })
    phone.items.put('label', 'l1', { name: 'Brand deals' })
    phone.items.remove('label', 'l2')
    await phone.client.syncNow()
    await desktop.client.syncNow()
    expect(desktop.rows('snooze').get(syncKey('me@example.com', '<x@y>')!)).toEqual({ until: 123 })
    expect(desktop.rows('label').get('l1')).toEqual({ name: 'Brand deals' })
    expect(desktop.rows('label').has('l2')).toBe(false)
  })

  it('does nothing the second time when nothing changed', async () => {
    const { desktop, phone } = await pair()
    desktop.rows('deal').set('d1', deal)
    await desktop.client.syncNow()
    await phone.client.syncNow()
    const groupId = (await desktop.client.pairing())!.groupId
    const before = deps.store.pull(groupId, 0, 500).seq
    tick()
    await phone.client.syncNow()
    await desktop.client.syncNow()
    await phone.client.syncNow()
    expect(deps.store.pull(groupId, 0, 500).seq).toBe(before)
  })

  it('keeps the phone and the desktop in agreement about a change made on both', async () => {
    const { desktop, phone } = await pair()
    desktop.rows('deal').set('d1', deal)
    await desktop.client.syncNow()
    await phone.client.syncNow()
    tick()
    desktop.rows('deal').set('d1', { ...deal, stage: 'contracted', updatedAt: 3 })
    await desktop.client.syncNow()
    tick()
    phone.items.put('deal', 'd1', { ...deal, stage: 'paid', updatedAt: 4 })
    await phone.client.syncNow()
    await desktop.client.syncNow()
    expect((desktop.rows('deal').get('d1') as { stage: string }).stage).toBe('paid')
    expect(phone.items.get<{ stage: string }>('deal', 'd1')!.stage).toBe('paid')
  })

  it('keeps its bookkeeping in the database, and forgets it all when turned off', async () => {
    const { phone } = await pair()
    await phone.client.syncNow()
    expect(phone.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM sync_state')!.n).toBeGreaterThan(3)
    expect(phone.client.status()).toMatchObject({ paired: true, deviceName: 'Phone', error: null })
    phone.items.put('label', 'keep', { name: 'Stays' })
    await phone.client.disable()
    expect(phone.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM sync_state')!.n).toBe(0)
    expect(phone.client.status().paired).toBe(false)
    // What was already on the phone stays.
    expect(phone.items.get('label', 'keep')).toEqual({ name: 'Stays' })
  })
})
