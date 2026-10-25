import { beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { ImapAccountInput } from '@imc/core'
import { migrate } from './db'
import { MessageService, type RemoteMail } from './messages'
import { DEFAULT_NOTIFICATIONS, Notifier, type Toast } from './notifications'
import { MailStore, type FetchedMessage } from './store'

const input: Omit<ImapAccountInput, 'password'> = {
  email: 'me@x.example',
  username: 'me',
  imap: { host: 'h', port: 993, security: 'tls' },
  smtp: { host: 'h', port: 465, security: 'tls' }
}
const NOW = Date.UTC(2026, 9, 25, 12)
const DAY = 24 * 3600e3

const sent = (uid: number, over: Partial<FetchedMessage> = {}): FetchedMessage => ({
  uid,
  messageId: `<s${uid}@x>`,
  fromName: 'Casey',
  fromAddr: 'me@x.example',
  to: 'Pat Lee <pat@nova.example>',
  subject: 'Rates for Q4',
  date: NOW - DAY,
  flags: ['\Seen'],
  refs: [],
  ...over
})

describe('follow-up reminders', () => {
  let store: MailStore
  let svc: MessageService
  let acct: string
  let inbox: string
  let sentBox: string
  const remote: RemoteMail = { fetchSource: vi.fn(), setFlags: vi.fn(), moveMessage: vi.fn(), deleteMessage: vi.fn() }

  beforeEach(() => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    store = new MailStore(db)
    acct = store.addAccount(input, 'imap').id
    inbox = store.upsertFolder(acct, { path: 'INBOX', name: 'Inbox', role: 'inbox' })
    sentBox = store.upsertFolder(acct, { path: 'Sent', name: 'Sent', role: 'sent' })
    svc = new MessageService(store, remote)
    store.applyFetched(acct, sentBox, [sent(1), sent(2, { subject: 'Other pitch' })], null)
  })
  const id = (uid: number) => `${sentBox}:${uid}`

  it('sets, shows and clears a reminder, and lists it in its own view soonest first', () => {
    svc.followUp(id(1), NOW + 3 * DAY, NOW)
    svc.followUp(id(2), NOW + 1 * DAY, NOW)
    const rows = store.listMessages({ view: 'followUp', limit: 10, offset: 0 }, NOW)
    expect(rows.map((r) => r.uid)).toEqual([2, 1])
    expect(rows.map((r) => r.followUpAt)).toEqual([NOW + DAY, NOW + 3 * DAY])
    expect(store.viewCounts(NOW).followUp).toBe(2)
    expect(store.followUpAt(id(1))).toBe(NOW + 3 * DAY)
    svc.followUp(id(1), null, NOW)
    expect(store.viewCounts(NOW).followUp).toBe(1)
  })

  it('refuses times in the past or more than a year away', () => {
    expect(() => svc.followUp(id(1), NOW, NOW)).toThrow(/future/)
    expect(() => svc.followUp(id(1), NOW + 400 * DAY, NOW)).toThrow(/within a year/)
  })

  it('fires once when due, and keeps the reminder visible afterwards', () => {
    svc.followUp(id(1), NOW + 2 * DAY, NOW)
    expect(store.followUpTick(NOW + DAY)).toEqual([])
    expect(store.followUpTick(NOW + 2 * DAY + 1000)).toEqual([id(1)])
    expect(store.followUpTick(NOW + 3 * DAY)).toEqual([]) // not shown twice
    expect(store.followUpAt(id(1))).toBe(NOW + 2 * DAY)
  })

  it('drops the reminder when someone else replies, but not when you send another message', () => {
    svc.followUp(id(1), NOW + 2 * DAY, NOW)
    store.applyFetched(acct, sentBox, [sent(3, { refs: ['<s1@x>'], date: NOW - 1000, subject: 'Re: Rates for Q4' })], null)
    store.rethread(acct)
    expect(store.followUpTick(NOW + 2 * DAY + 1000)).toEqual([id(1)]) // my own follow-up is not an answer
    svc.followUp(id(2), NOW + 2 * DAY, NOW)
    store.applyFetched(
      acct,
      inbox,
      [{ ...sent(1), uid: 9, messageId: '<r@nova>', fromName: 'Pat', fromAddr: 'pat@nova.example', to: 'me@x.example', subject: 'Re: Other pitch', date: NOW + 1000, refs: ['<s2@x>'] }],
      null
    )
    store.rethread(acct)
    expect(store.followUpTick(NOW + 2 * DAY + 1000)).toEqual([])
    expect(store.followUpAt(id(2))).toBeNull()
  })

  it('notifies as "No reply yet", names who you wrote to, and respects stream-safe', () => {
    svc.followUp(id(1), NOW + DAY, NOW)
    const toasts: Toast[] = []
    let active = false
    const n = new Notifier({
      getSettings: () => ({ ...DEFAULT_NOTIFICATIONS, enabled: true, whenStreamSafe: 'generic' as const, quietHours: { enabled: false, start: '22:00', end: '07:00' } }),
      streamActive: () => active,
      load: () => [],
      loadSent: (ids) => store.sentItems(ids),
      show: (t) => toasts.push(t),
      now: () => new Date(NOW),
      batchMs: 0
    })
    n.handleFollowUp([id(1)])
    n.flush()
    expect(toasts).toEqual([{ title: 'Pat Lee', body: 'No reply yet: Rates for Q4', messageId: id(1) }])
    active = true
    n.handleFollowUp([id(1)])
    n.flush()
    expect(toasts[1]).toEqual({ title: 'IMC-Mail', body: 'New message', messageId: null })
  })
})
