import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import type { ImapAccountInput } from '@imc/core'
import { brandFrom } from './deals'
import { migrate } from './db'
import { MailStore, type FetchedMessage } from './store'

const input: ImapAccountInput = {
  email: 'me@x.example',
  username: 'me',
  password: 'p',
  imap: { host: 'h', port: 993, security: 'tls' },
  smtp: { host: 'h', port: 465, security: 'tls' }
}

const NOW = Date.UTC(2026, 9, 25, 12)
const DAY = 24 * 3600 * 1000

const msg = (uid: number, over: Partial<FetchedMessage> = {}): FetchedMessage => ({
  uid,
  messageId: `<m${uid}@x>`,
  fromName: 'Someone',
  fromAddr: 'someone@y.example',
  to: 'me@x.example',
  subject: `Subject ${uid}`,
  date: NOW - uid * 3600e3,
  flags: [],
  refs: [],
  ...over
})

describe('categories, views, deals', () => {
  let store: MailStore
  let db: Database.Database
  let acct: string
  let inbox: string
  let sent: string

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    store = new MailStore(db)
    acct = store.addAccount(input, 'imap').id
    inbox = store.upsertFolder(acct, { path: 'INBOX', name: 'Inbox', role: 'inbox' })
    sent = store.upsertFolder(acct, { path: 'Sent', name: 'Sent', role: 'sent' })
  })

  const list = (q: Parameters<MailStore['listMessages']>[0]) => store.listMessages(q, NOW).map((m) => m.uid)

  describe('categories', () => {
    it('files mail as it arrives, shows it in lists and search, and filters by category', () => {
      store.applyFetched(
        acct,
        inbox,
        [
          msg(1, { fromAddr: 'partnerships@nova.example', subject: 'Paid partnership: Q4 campaign brief' }),
          msg(2, { fromAddr: 'no-reply@twitch.tv', subject: 'Your payout has been issued' }),
          msg(3, { fromAddr: 'mum@gmail.com', subject: 'Dinner?' })
        ],
        null
      )
      const byUid = Object.fromEntries(store.listMessages({ folderId: inbox, limit: 10, offset: 0 }).map((m) => [m.uid, m.category]))
      expect(byUid).toEqual({ 1: 'sponsorship', 2: 'platform', 3: 'other' })
      expect(list({ folderId: inbox, limit: 10, offset: 0, category: 'sponsorship' })).toEqual([1])
      expect(store.search('category:platform').map((m) => m.uid)).toEqual([2])
      expect(store.search('cat:spons').map((m) => m.uid)).toEqual([1])
    })

    it('sharpens the verdict once the body is downloaded', () => {
      store.applyFetched(acct, inbox, [msg(1, { fromAddr: 'jo@brand.example', subject: 'Hi' })], null)
      expect(store.getMessage(`${inbox}:1`)?.category).toBe('other')
      store.saveBody(
        `${inbox}:1`,
        { html: null, text: 'We would love a brand deal: our rate card, deliverables and usage rights are attached.', to: '', cc: '', attachments: [], truncated: false },
        'We would love'
      )
      expect(store.getMessage(`${inbox}:1`)?.category).toBe('sponsorship')
    })

    it('your choice wins over the rules, and can be handed back', () => {
      store.applyFetched(acct, inbox, [msg(1, { fromAddr: 'partnerships@nova.example', subject: 'Sponsorship' })], null)
      store.setCategory(`${inbox}:1`, 'collab')
      expect(store.listMessages({ folderId: inbox, limit: 5, offset: 0 })[0]?.category).toBe('collab')
      store.saveBody(`${inbox}:1`, { html: null, text: 'sponsorship brand deal rate card', to: '', cc: '', attachments: [], truncated: false }, '')
      expect(store.listMessages({ folderId: inbox, limit: 5, offset: 0 })[0]?.category).toBe('collab') // body does not undo it
      store.setCategory(`${inbox}:1`, null)
      expect(store.listMessages({ folderId: inbox, limit: 5, offset: 0 })[0]?.category).toBe('sponsorship')
    })

    it('backfills mail cached before categories existed', () => {
      store.applyFetched(acct, inbox, [msg(1, { fromAddr: 'billing@pf.example', subject: 'Invoice 7' })], null)
      db.exec('UPDATE message SET category = NULL')
      expect(store.backfillCategories()).toBe(1)
      expect(store.getMessage(`${inbox}:1`)?.category).toBe('invoice')
      expect(store.backfillCategories()).toBe(0)
    })
  })

  describe('needs reply', () => {
    it('lists the latest message from someone else, until you answer', () => {
      store.applyFetched(acct, inbox, [msg(1), msg(2, { fromAddr: 'other@z.example' })], null)
      expect(list({ view: 'needsReply', limit: 10, offset: 0 })).toEqual([1, 2])

      // You reply to message 2: it leaves the list, message 1 stays.
      store.applyFetched(
        acct,
        sent,
        [msg(10, { fromName: 'Me', fromAddr: 'me@x.example', to: 'other@z.example', refs: ['<m2@x>'], subject: 'Re: Subject 2', date: NOW - 3600e3 / 2 })],
        null
      )
      store.rethread(acct)
      expect(list({ view: 'needsReply', limit: 10, offset: 0 })).toEqual([1])
    })

    it('skips bots, bulk mail, answered mail, your own mail, and old mail', () => {
      store.applyFetched(
        acct,
        inbox,
        [
          msg(1, { fromAddr: 'noreply@shop.example' }),
          msg(2, { fromAddr: 'sales@growth.example', subject: 'Grow your channel: 50% off' }),
          msg(3, { flags: ['\\Answered'] }),
          msg(4, { fromAddr: 'me@x.example' }),
          msg(5, { date: NOW - 45 * DAY }),
          msg(6, { fromAddr: 'real@person.example' })
        ],
        null
      )
      expect(list({ view: 'needsReply', limit: 10, offset: 0 })).toEqual([6])
    })

    it('counts match the lists', () => {
      store.applyFetched(acct, inbox, [msg(1), msg(2, { flags: ['\\Seen'], fromAddr: 'partnerships@nova.example', subject: 'Sponsorship' })], null)
      const c = store.viewCounts(NOW)
      expect(c.needsReply).toBe(2)
      expect(c.categories.find((x) => x.category === 'sponsorship')).toMatchObject({ total: 1, unread: 0 })
      expect(c.categories.find((x) => x.category === 'other')).toMatchObject({ total: 1, unread: 1 })
    })
  })

  describe('waiting on a reply', () => {
    const mine = (uid: number, over: Partial<FetchedMessage> = {}) =>
      msg(uid, { fromName: 'Me', fromAddr: 'me@x.example', to: 'pat@y.example', ...over })

    it('lists sent mail nobody has answered after three days', () => {
      store.applyFetched(
        acct,
        sent,
        [
          mine(1, { date: NOW - 5 * DAY }), // old enough, unanswered
          mine(2, { date: NOW - 1 * DAY }), // too recent
          mine(3, { date: NOW - 6 * DAY, messageId: '<q@x>' }), // answered below
          mine(4, { date: NOW - 40 * DAY }), // too old to chase
          mine(5, { date: NOW - 5 * DAY, to: '' }) // no recipient
        ],
        null
      )
      store.applyFetched(acct, inbox, [msg(20, { fromAddr: 'pat@y.example', refs: ['<q@x>'], subject: 'Re: Subject 3', date: NOW - 4 * DAY })], null)
      store.rethread(acct)
      expect(list({ view: 'waiting', limit: 10, offset: 0 })).toEqual([1])
      expect(store.viewCounts(NOW).waiting).toBe(1)
    })
  })

  describe('deals', () => {
    it('creates, updates, stamps the paid date, and deletes', () => {
      const d = store.createDeal({ accountId: acct, messageId: null, brand: 'Nova', rate: 4000 }, 1000)
      expect(d).toMatchObject({ brand: 'Nova', stage: 'lead', rate: 4000, currency: 'USD', paidAt: null })

      const moved = store.updateDeal(d.id, { stage: 'contracted', dueDate: 5000 }, 2000)
      expect(moved).toMatchObject({ stage: 'contracted', dueDate: 5000, updatedAt: 2000, brand: 'Nova' })

      const paid = store.updateDeal(d.id, { stage: 'paid' }, 3000)
      expect(paid.paidAt).toBe(3000)
      expect(store.updateDeal(d.id, { notes: 'invoice sent' }, 4000).paidAt).toBe(3000) // unchanged while paid
      expect(store.updateDeal(d.id, { stage: 'delivered' }, 5000).paidAt).toBeNull()

      expect(store.listDeals()).toHaveLength(1)
      store.deleteDeal(d.id)
      expect(store.listDeals()).toHaveLength(0)
      expect(() => store.updateDeal('nope', { notes: 'x' })).toThrow(/no longer exists/)
    })

    it('a deal survives the message it came from being archived', () => {
      store.applyFetched(acct, inbox, [msg(1)], null)
      const d = store.createDeal({ accountId: acct, messageId: `${inbox}:1`, brand: 'X' })
      store.removeMessage(`${inbox}:1`)
      expect(store.getDeal(d.id)?.messageId).toBe(`${inbox}:1`)
    })

    it('goes with its account', () => {
      store.createDeal({ accountId: acct, messageId: null, brand: 'X' })
      store.removeAccount(acct)
      expect(store.listDeals()).toHaveLength(0)
    })
  })

  describe('brandFrom', () => {
    it('prefers a clean display name, then the domain', () => {
      expect(brandFrom('Nova Energy Partnerships (demo)', 'p@nova.example')).toBe('Nova Energy Partnerships')
      expect(brandFrom('"Nova Energy"', 'p@nova.example')).toBe('Nova Energy')
      expect(brandFrom('', 'p@nova-energy.example')).toBe('Nova-energy')
      expect(brandFrom('p@nova.example', 'p@nova.example')).toBe('Nova')
    })
  })
})
