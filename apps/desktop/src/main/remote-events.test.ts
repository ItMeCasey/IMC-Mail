import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import type { ImapAccountInput, RemoteEvent } from '@imc/core'
import { migrate } from './db'
import { MailStore } from './store'

const input = (email: string): ImapAccountInput => ({
  email,
  username: email,
  password: 'pw',
  imap: { host: 'imap.example.com', port: 993, security: 'tls' },
  smtp: { host: 'smtp.example.com', port: 465, security: 'tls' }
})

const ev = (id: string, start: number, over: Partial<RemoteEvent> = {}): RemoteEvent => ({
  remoteId: id,
  uid: `${id}@cal`,
  summary: `Meeting ${id}`,
  description: '',
  location: '',
  start,
  end: start + 3600e3,
  allDay: false,
  status: 'CONFIRMED',
  onlineUrl: null,
  organizer: { name: 'Pat', email: 'pat@x.example' },
  attendees: [{ name: 'Sam', email: 'sam@x.example', partstat: 'ACCEPTED' }],
  myResponse: 'accepted',
  mine: false,
  free: false,
  ...over
})

const H = 3600e3

describe('synced calendar events', () => {
  let store: MailStore
  let a: string
  let b: string

  beforeEach(() => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    store = new MailStore(db)
    a = store.addAccount(input('a@x.com'), 'imap').id
    b = store.addAccount(input('b@x.com'), 'imap').id
  })

  it('stores events and returns the ones that overlap a window, in time order', () => {
    store.replaceRemoteEvents(a, 0, 100 * H, [ev('late', 50 * H), ev('early', 10 * H), ev('far', 500 * H)])
    const got = store.remoteEventsInRange(0, 100 * H)
    expect(got.map((e) => e.summary)).toEqual(['Meeting early', 'Meeting late'])
    expect(got[0]).toMatchObject({ accountId: a, organizer: { email: 'pat@x.example' }, attendees: [{ partstat: 'ACCEPTED' }], allDay: false, mine: false })
    // one that began before the window but runs into it still counts
    store.replaceRemoteEvents(a, 0, 1000 * H, [ev('long', 5 * H, { end: 60 * H })])
    expect(store.remoteEventsInRange(40 * H, 50 * H).map((e) => e.summary)).toContain('Meeting long')
  })

  it('a sync replaces its window, drops what disappeared, and leaves other accounts and other times alone', () => {
    store.replaceRemoteEvents(a, 0, 100 * H, [ev('x', 10 * H), ev('y', 20 * H)])
    store.replaceRemoteEvents(b, 0, 100 * H, [ev('x', 10 * H)])
    store.replaceRemoteEvents(a, 0, 200 * H, [ev('y', 20 * H, { summary: 'Renamed' }), ev('z', 150 * H)])
    const all = store.remoteEventsInRange(0, 1000 * H)
    expect(all.filter((e) => e.accountId === a).map((e) => e.summary).sort()).toEqual(['Meeting z', 'Renamed'])
    expect(all.filter((e) => e.accountId === b)).toHaveLength(1)
    store.replaceRemoteEvents(a, 0, 100 * H, [])
    expect(store.remoteEventsInRange(0, 100 * H).filter((e) => e.accountId === a)).toEqual([])
    expect(store.remoteEventsInRange(0, 1000 * H).some((e) => e.summary === 'Meeting z')).toBe(true) // outside that window
  })

  it('remembers when each calendar was read, and the last problem', () => {
    store.setRemoteSync(a, 1000, null)
    store.setRemoteSync(a, null, 'No network')
    expect(store.remoteSyncStates()).toEqual([{ accountId: a, syncedAt: 1000, error: 'No network' }])
    store.setRemoteSync(a, 2000, null)
    expect(store.remoteSyncStates()).toEqual([{ accountId: a, syncedAt: 2000, error: null }])
  })

  it('goes away with the account, or when the calendar is disconnected', () => {
    store.replaceRemoteEvents(a, 0, 100 * H, [ev('x', 10 * H)])
    store.replaceRemoteEvents(b, 0, 100 * H, [ev('x', 10 * H)])
    store.setRemoteSync(a, 1, null)
    store.clearRemoteEvents(a)
    expect(store.remoteEventsInRange(0, 100 * H).map((e) => e.accountId)).toEqual([b])
    expect(store.remoteSyncStates()).toEqual([])
    store.removeAccount(b)
    expect(store.remoteEventsInRange(0, 100 * H)).toEqual([])
  })
})
