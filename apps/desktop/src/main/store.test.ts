import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import type { ImapAccountInput } from '@imc/core'
import { migrate } from './db'
import { MailStore, type FetchedMessage } from './store'

const input = (email: string): ImapAccountInput => ({
  email,
  username: email,
  password: 'pw',
  imap: { host: 'imap.example.com', port: 993, security: 'tls' },
  smtp: { host: 'smtp.example.com', port: 465, security: 'tls' }
})

const msg = (uid: number, flags: string[] = [], date = uid * 1000): FetchedMessage => ({
  uid,
  messageId: `<${uid}@x>`,
  fromName: `Sender ${uid}`,
  fromAddr: `s${uid}@x.com`,
  to: 'me@x.com',
  subject: `Subject ${uid}`,
  date,
  flags,
  refs: []
})

describe('MailStore', () => {
  let store: MailStore
  let accountId: string
  let inbox: string

  beforeEach(() => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    store = new MailStore(db)
    accountId = store.addAccount(input('a@x.com'), 'imap').id
    inbox = store.upsertFolder(accountId, { path: 'INBOX', name: 'Inbox', role: 'inbox' })
  })

  it('never exposes the password in stored config', () => {
    const acc = store.getAccount(accountId)!
    expect(JSON.stringify(acc.config)).not.toContain('pw')
  })

  it('counts unread from the \\Seen flag and tracks flag changes', () => {
    store.applyFetched(accountId, inbox, [msg(1, ['\\Seen']), msg(2), msg(3)], null)
    expect(store.listFolders()[0]).toMatchObject({ total: 3, unread: 2 })

    store.applyFetched(accountId, inbox, [msg(2, ['\\Seen', '\\Flagged'])], null)
    expect(store.listFolders()[0]?.unread).toBe(1)
    expect(store.listMessages({ folderId: inbox, limit: 10, offset: 0 }).find((m) => m.uid === 2))
      .toMatchObject({ unread: false, starred: true })
  })

  it('removes messages the server no longer has, only inside the window', () => {
    store.applyFetched(accountId, inbox, [msg(1), msg(2), msg(3), msg(4)], null)
    // Server now reports 3 and 4 only; uid 1 is below the window start and must stay.
    store.applyFetched(accountId, inbox, [msg(4)], 2)
    const uids = store.listMessages({ folderId: inbox, limit: 10, offset: 0 }).map((m) => m.uid)
    expect(uids.sort()).toEqual([1, 4])
  })

  it('computes the window start uid', () => {
    expect(store.windowStartUid(inbox, 2)).toBeNull()
    store.applyFetched(accountId, inbox, [msg(5), msg(9), msg(12)], null)
    expect(store.windowStartUid(inbox, 2)).toBe(9)
    expect(store.windowStartUid(inbox, 10)).toBe(5)
  })

  it('unified inbox spans accounts and excludes other folders', () => {
    const b = store.addAccount(input('b@x.com'), 'imap').id
    const bInbox = store.upsertFolder(b, { path: 'INBOX', name: 'Inbox', role: 'inbox' })
    const sent = store.upsertFolder(b, { path: 'Sent', name: 'Sent', role: 'sent' })
    store.applyFetched(accountId, inbox, [msg(1, [], 100)], null)
    store.applyFetched(b, bInbox, [msg(1, [], 300)], null)
    store.applyFetched(b, sent, [msg(2, [], 500)], null)

    const all = store.listMessages({ limit: 10, offset: 0 })
    expect(all.map((m) => m.accountId)).toEqual([b, accountId])
    expect(store.listMessages({ accountId: b, limit: 10, offset: 0 })).toHaveLength(1)
  })

  it('removing an account cascades to folders and messages', () => {
    store.applyFetched(accountId, inbox, [msg(1)], null)
    store.removeAccount(accountId)
    expect(store.listFolders()).toHaveLength(0)
    expect(store.listMessages({ limit: 10, offset: 0 })).toHaveLength(0)
  })

  it('clearFolder wipes cached messages', () => {
    store.applyFetched(accountId, inbox, [msg(1), msg(2)], null)
    store.clearFolder(inbox)
    expect(store.listFolders()[0]?.total).toBe(0)
  })
})
