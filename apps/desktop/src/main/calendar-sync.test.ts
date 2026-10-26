import { beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { ImapAccountInput, Provider } from '@imc/core'
import { CalendarSync } from './calendar-sync'
import { migrate } from './db'
import { CalendarNotConnected } from './oauth'
import { MailStore } from './store'

const input = (email: string): ImapAccountInput => ({
  email,
  username: email,
  password: 'pw',
  imap: { host: 'imap.example.com', port: 993, security: 'tls' },
  smtp: { host: 'smtp.example.com', port: 465, security: 'tls' }
})

const NOW = Date.UTC(2026, 10, 1)
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const gEvent = (id: string, hours: number) => ({
  id,
  iCalUID: `${id}@google.com`,
  summary: `Event ${id}`,
  status: 'confirmed',
  start: { dateTime: new Date(NOW + hours * 3600e3).toISOString() },
  end: { dateTime: new Date(NOW + (hours + 1) * 3600e3).toISOString() }
})
const mEvent = (id: string, hours: number) => ({
  id,
  iCalUId: `${id}@outlook`,
  subject: `Meeting ${id}`,
  start: { dateTime: new Date(NOW + hours * 3600e3).toISOString().slice(0, 19) + '.0000000' },
  end: { dateTime: new Date(NOW + (hours + 1) * 3600e3).toISOString().slice(0, 19) + '.0000000' },
  isAllDay: false,
  responseStatus: { response: 'accepted' }
})

describe('CalendarSync', () => {
  let store: MailStore
  let changed: string[]
  const make = (fetchFn: unknown, token: () => Promise<string> = async () => 'tok') =>
    new CalendarSync({
      store,
      calendarToken: token,
      onChange: (id) => changed.push(id),
      fetchFn: fetchFn as typeof fetch,
      now: () => NOW
    })
  const account = (email: string, provider: Provider) => store.addAccount(input(email), provider, provider === 'imap' ? 'password' : 'oauth').id
  const events = () => store.remoteEventsInRange(NOW - 30 * 86400e3, NOW + 365 * 86400e3)

  beforeEach(() => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    store = new MailStore(db)
    changed = []
  })

  it('reads every page of a Google calendar with the account token', async () => {
    const id = account('me@gmail.com', 'gmail')
    const urls: string[] = []
    const auth: string[] = []
    const fetchFn = vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      urls.push(url)
      auth.push(init.headers['Authorization']!)
      return url.includes('pageToken=p2') ? json({ items: [gEvent('b', 48)] }) : json({ items: [gEvent('a', 24)], nextPageToken: 'p2' })
    })
    const r = await make(fetchFn).syncAccount(id)
    expect(r).toEqual({ state: 'connected' })
    expect(events().map((e) => e.summary)).toEqual(['Event a', 'Event b'])
    expect(urls[0]).toContain('https://www.googleapis.com/calendar/v3/calendars/primary/events')
    expect(auth).toEqual(['Bearer tok', 'Bearer tok'])
    expect(store.remoteSyncStates()).toEqual([{ accountId: id, syncedAt: NOW, error: null }])
    expect(changed).toEqual([id])
  })

  it('reads a Microsoft calendar in UTC and never follows a next link that leaves Graph', async () => {
    const id = account('me@hotmail.com', 'microsoft')
    const seen: { url: string; prefer?: string }[] = []
    const fetchFn = vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, prefer: init.headers['Prefer'] })
      return seen.length === 1
        ? json({ value: [mEvent('a', 24)], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendarView?$skip=200' })
        : seen.length === 2
          ? json({ value: [mEvent('b', 30)], '@odata.nextLink': 'https://evil.example/steal' })
          : json({ value: [] })
    })
    await make(fetchFn).syncAccount(id)
    expect(seen).toHaveLength(2)
    expect(seen[0]!.prefer).toBe('outlook.timezone="UTC"')
    expect(seen.every((s) => s.url.startsWith('https://graph.microsoft.com/'))).toBe(true)
    expect(events().map((e) => e.summary)).toEqual(['Meeting a', 'Meeting b'])
  })

  it('a later read replaces the earlier one', async () => {
    const id = account('me@gmail.com', 'gmail')
    let items = [gEvent('a', 24), gEvent('b', 48)]
    const sync = make(async () => json({ items }))
    await sync.syncAccount(id)
    items = [gEvent('b', 48)]
    await sync.syncAccount(id)
    expect(events().map((e) => e.summary)).toEqual(['Event b'])
  })

  it('when the account has not allowed the calendar, nothing is kept and it says so', async () => {
    const id = account('me@gmail.com', 'gmail')
    await make(async () => json({ items: [gEvent('a', 24)] })).syncAccount(id)
    expect(events()).toHaveLength(1)
    const sync = make(vi.fn(), async () => {
      throw new CalendarNotConnected()
    })
    expect(await sync.syncAccount(id)).toEqual({ state: 'not-connected' })
    expect(events()).toEqual([])
    expect(store.remoteSyncStates()).toEqual([])
  })

  it('keeps the old events and records a plain reason when the service fails', async () => {
    const id = account('me@gmail.com', 'gmail')
    await make(async () => json({ items: [gEvent('a', 24)] })).syncAccount(id)
    const r = await make(async () => json({ error: { code: 503, message: 'Backend down' } }, 503)).syncAccount(id)
    expect(r).toEqual({ state: 'error', error: 'The calendar service answered 503: Backend down.' })
    expect(events()).toHaveLength(1)
    expect(store.remoteSyncStates()[0]).toMatchObject({ syncedAt: NOW, error: 'The calendar service answered 503: Backend down.' })

    const net = await make(async () => {
      throw new TypeError('fetch failed')
    }).syncAccount(id)
    expect(net).toMatchObject({ state: 'error', error: expect.stringMatching(/Could not reach/) })
  })

  it('explains a Google project where the Calendar API is switched off', async () => {
    const id = account('me@gmail.com', 'gmail')
    const body = { error: { code: 403, message: 'Google Calendar API has not been used in project 123 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }] } }
    const r = await make(async () => json(body, 403)).syncAccount(id)
    expect(r).toMatchObject({ state: 'error', error: expect.stringMatching(/turned off for your Google Cloud project/) })
  })

  it('shares one read between simultaneous requests, and skips password accounts', async () => {
    const id = account('me@gmail.com', 'gmail')
    const plain = account('me@example.com', 'imap')
    const fetchFn = vi.fn(async () => json({ items: [] }))
    const sync = make(fetchFn)
    await Promise.all([sync.syncAccount(id), sync.syncAccount(id)])
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(await sync.syncAccount(plain)).toEqual({ state: 'not-connected' })
    await sync.syncAll()
    expect(fetchFn).toHaveBeenCalledTimes(2) // only the Google account
  })
})
