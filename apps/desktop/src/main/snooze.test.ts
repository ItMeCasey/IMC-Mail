import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { ImapAccountInput } from '@imc/core'
import { migrate } from './db'
import { MessageService, type RemoteMail } from './messages'
import { DEFAULT_NOTIFICATIONS, Notifier, type Toast } from './notifications'
import { SnoozeWaker } from './snooze'
import { MailStore, type FetchedMessage } from './store'

const input: ImapAccountInput = {
  email: 'me@x.example',
  username: 'me',
  password: 'p',
  imap: { host: 'h', port: 993, security: 'tls' },
  smtp: { host: 'h', port: 465, security: 'tls' }
}
const NOW = Date.UTC(2026, 9, 25, 12)
const HOUR = 3600e3

const msg = (uid: number, over: Partial<FetchedMessage> = {}): FetchedMessage => ({
  uid,
  messageId: `<m${uid}@x>`,
  fromName: 'Nova',
  fromAddr: 'partners@nova.example',
  to: 'me@x.example',
  subject: `Brief ${uid}`,
  date: NOW - uid * 1000,
  flags: ['\\Seen'],
  refs: [],
  ...over
})

describe('snooze', () => {
  let store: MailStore
  let svc: MessageService
  let acct: string
  let inbox: string
  const remote: RemoteMail = {
    fetchSource: vi.fn(),
    setFlags: vi.fn(),
    moveMessage: vi.fn(),
    deleteMessage: vi.fn()
  }

  beforeEach(() => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    store = new MailStore(db)
    acct = store.addAccount(input, 'imap').id
    inbox = store.upsertFolder(acct, { path: 'INBOX', name: 'Inbox', role: 'inbox' })
    svc = new MessageService(store, remote)
    store.applyFetched(acct, inbox, [msg(1), msg(2), msg(3)], null)
  })

  const ids = (q: Parameters<MailStore['listMessages']>[0]) => store.listMessages(q, NOW).map((m) => m.uid)
  const id = (uid: number) => `${inbox}:${uid}`

  it('hides a snoozed message from every list, folder counts, and smart views', () => {
    expect(ids({ folderId: inbox, limit: 10, offset: 0 })).toEqual([1, 2, 3])
    svc.snooze(id(2), NOW + 5 * HOUR, NOW)
    expect(ids({ folderId: inbox, limit: 10, offset: 0 })).toEqual([1, 3])
    expect(ids({ limit: 10, offset: 0 })).toEqual([1, 3]) // unified inbox
    expect(store.listFolders()[0]?.total).toBe(2)
    expect(store.viewCounts(NOW).snoozed).toBe(1)
    expect(store.viewCounts(NOW).needsReply).toBe(2)
  })

  it('lists snoozed mail soonest-first in its own view, with the wake time', () => {
    svc.snooze(id(1), NOW + 9 * HOUR, NOW)
    svc.snooze(id(3), NOW + 2 * HOUR, NOW)
    const rows = store.listMessages({ view: 'snoozed', limit: 10, offset: 0 }, NOW)
    expect(rows.map((r) => r.uid)).toEqual([3, 1])
    expect(rows.map((r) => r.snoozedUntil)).toEqual([NOW + 2 * HOUR, NOW + 9 * HOUR])
  })

  it('search still finds snoozed mail', () => {
    svc.snooze(id(2), NOW + HOUR, NOW)
    expect(store.search('brief').map((m) => m.uid).sort()).toEqual([1, 2, 3])
  })

  it('un-snoozing, or re-snoozing to another time, replaces the old one', () => {
    svc.snooze(id(1), NOW + HOUR, NOW)
    svc.snooze(id(1), NOW + 5 * HOUR, NOW)
    expect(store.snoozedUntil(id(1))).toBe(NOW + 5 * HOUR)
    svc.snooze(id(1), null)
    expect(store.snoozedUntil(id(1))).toBeNull()
    expect(ids({ folderId: inbox, limit: 10, offset: 0 })).toEqual([1, 2, 3])
  })

  it('refuses nonsense times', () => {
    expect(() => svc.snooze(id(1), NOW + 1000, NOW)).toThrow(/future/)
    expect(() => svc.snooze(id(1), NOW + 400 * 24 * HOUR, NOW)).toThrow(/year/)
    expect(() => svc.snooze('nope', NOW + HOUR, NOW)).toThrow(/no longer/)
  })

  it('wakeDue returns and clears only what is due', () => {
    svc.snooze(id(1), NOW + HOUR, NOW)
    svc.snooze(id(2), NOW + 8 * HOUR, NOW)
    expect(store.wakeDue(NOW + 2 * HOUR)).toEqual([id(1)])
    expect(store.wakeDue(NOW + 2 * HOUR)).toEqual([])
    expect(store.viewCounts(NOW).snoozed).toBe(1)
  })

  it('goes away with the message', () => {
    svc.snooze(id(1), NOW + HOUR, NOW)
    store.removeMessage(id(1))
    expect(store.viewCounts(NOW).snoozed).toBe(0)
  })

  it('shows the wake time in the message detail', async () => {
    svc.snooze(id(1), NOW + HOUR, NOW)
    expect(store.snoozedUntil(id(1))).toBe(NOW + HOUR)
  })

  describe('waking', () => {
    it('brings a due message back as unread, once, and reports it', async () => {
      svc.snooze(id(1), NOW + HOUR, NOW)
      const woken: string[][] = []
      const waker = new SnoozeWaker({
        wakeDue: (n) => store.wakeDue(n),
        markUnread: async (m) => void store.setLocalFlags(m, { seen: false }),
        onWoken: (w) => woken.push(w),
        now: () => NOW + 2 * HOUR
      })
      expect(await waker.tick()).toEqual([id(1)])
      expect(await waker.tick()).toEqual([])
      expect(woken).toEqual([[id(1)]])
      const row = store.listMessages({ folderId: inbox, limit: 10, offset: 0 }, NOW).find((r) => r.uid === 1)
      expect(row).toMatchObject({ unread: true, snoozedUntil: null })
    })

    it('still returns the message when marking it unread on the server fails', async () => {
      svc.snooze(id(1), NOW + HOUR, NOW)
      const woken: string[][] = []
      const waker = new SnoozeWaker({
        wakeDue: (n) => store.wakeDue(n),
        markUnread: async () => {
          throw new Error('Offline')
        },
        onWoken: (w) => woken.push(w),
        now: () => NOW + 2 * HOUR
      })
      await waker.tick()
      expect(woken).toEqual([[id(1)]])
    })
  })
})

describe('wake notifications', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const make = (over: { stream?: boolean; quiet?: boolean; risk?: 'none' | 'danger' } = {}) => {
    const shown: Toast[] = []
    const n = new Notifier({
      getSettings: () => ({
        ...DEFAULT_NOTIFICATIONS,
        categories: [], // muted categories must not stop a wake-up
        quietHours: { enabled: !!over.quiet, start: '00:00', end: '23:59' }
      }),
      streamActive: () => !!over.stream,
      load: (ids) =>
        ids.map((i) => ({
          id: i,
          fromName: 'Nova',
          fromAddr: 'p@nova.example',
          subject: 'Q4 brief',
          category: 'cold' as const,
          risk: over.risk ?? ('none' as const),
          date: 0, // years old
          unread: false
        })),
      show: (t) => shown.push(t),
      now: () => new Date(2026, 9, 25, 12)
    })
    return { n, shown }
  }

  it('notifies even though the mail is old, read, and in a muted category', () => {
    const t = make()
    t.n.handleWake(['a'])
    vi.advanceTimersByTime(2000)
    expect(t.shown).toEqual([{ title: 'Nova', body: 'Snoozed: Q4 brief', messageId: 'a' }])
  })

  it('still respects quiet hours, stream-safe silence, and scam warnings', () => {
    for (const over of [{ quiet: true }, { stream: true }, { risk: 'danger' as const }]) {
      const t = make(over)
      t.n.handleWake(['a'])
      vi.advanceTimersByTime(2000)
      expect(t.shown).toEqual([])
    }
  })
})
