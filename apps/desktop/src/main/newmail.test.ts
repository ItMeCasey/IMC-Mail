import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import type { ImapAccountInput } from '@imc/core'
import { migrate } from './db'
import { MailStore, type FetchedMessage } from './store'

const input: ImapAccountInput = {
  email: 'me@x.example',
  username: 'me',
  password: 'p',
  imap: { host: 'h', port: 993, security: 'tls' },
  smtp: { host: 'h', port: 465, security: 'tls' }
}

const msg = (uid: number, over: Partial<FetchedMessage> = {}): FetchedMessage => ({
  uid,
  messageId: `<m${uid}@x>`,
  fromName: 'Nova',
  fromAddr: 'partners@nova.example',
  to: 'me@x.example',
  subject: 'Sponsorship brief',
  date: 5000 + uid,
  flags: [],
  refs: [],
  ...over
})

describe('new-mail detection', () => {
  let store: MailStore
  let acct: string
  let inbox: string
  let sent: string

  beforeEach(() => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    store = new MailStore(db)
    acct = store.addAccount(input, 'imap').id
    inbox = store.upsertFolder(acct, { path: 'INBOX', name: 'Inbox', role: 'inbox' })
    sent = store.upsertFolder(acct, { path: 'Sent', name: 'Sent', role: 'sent' })
  })

  it('applyFetched reports only messages it had not seen', () => {
    expect(store.applyFetched(acct, inbox, [msg(1), msg(2)], null)).toEqual([`${inbox}:1`, `${inbox}:2`])
    // A re-sync that also brings message 3: only 3 is new; 1 and 2 are just refreshed.
    expect(store.applyFetched(acct, inbox, [msg(2, { flags: ['\\Seen'] }), msg(3)], null)).toEqual([`${inbox}:3`])
    expect(store.applyFetched(acct, inbox, [msg(3)], null)).toEqual([])
  })

  it('incoming() describes inbox mail for the notification rules, and ignores other folders', () => {
    store.applyFetched(acct, inbox, [msg(1, { flags: [] }), msg(2, { flags: ['\\Seen'] })], null)
    store.applyFetched(acct, sent, [msg(9)], null)
    const got = store.incoming([`${inbox}:1`, `${inbox}:2`, `${sent}:9`, 'missing'])
    expect(got.map((g) => [g.id, g.unread, g.category, g.risk])).toEqual([
      [`${inbox}:1`, true, 'sponsorship', 'none'],
      [`${inbox}:2`, false, 'sponsorship', 'none']
    ])
    expect(got[0]).toMatchObject({ fromName: 'Nova', subject: 'Sponsorship brief' })
  })

  it('incoming() reflects a message marked safe, and a manual category', () => {
    store.applyFetched(acct, inbox, [msg(1, { fromName: 'YouTube Team', fromAddr: 'a@youtube-team-support.example', subject: 'Notice' })], null)
    expect(store.incoming([`${inbox}:1`])[0]?.risk).toBe('danger')
    store.setRiskSafe(`${inbox}:1`, true)
    store.setCategory(`${inbox}:1`, 'collab')
    expect(store.incoming([`${inbox}:1`])[0]).toMatchObject({ risk: 'none', category: 'collab' })
  })
})
