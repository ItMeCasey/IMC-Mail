import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import type { ImapAccountInput } from '@imc/core'
import { migrate } from './db'
import { buildSearch, parseQuery, tokenize } from './search'
import { MailStore, type FetchedMessage } from './store'

describe('tokenize', () => {
  it('keeps quoted phrases and key:"value" together', () => {
    expect(tokenize('from:nova "q4 brief" -spam subject:"big deal" plain')).toEqual([
      'from:nova',
      '"q4 brief"',
      '-spam',
      'subject:"big deal"',
      'plain'
    ])
  })
})

describe('parseQuery', () => {
  it('turns words into prefix matches and phrases into exact matches', () => {
    expect(parseQuery('invoice overdue').fts).toBe('"invoice"* "overdue"*')
    expect(parseQuery('"q4 brief"').fts).toBe('"q4 brief"')
  })

  it('maps field operators onto FTS columns', () => {
    expect(parseQuery('from:nova to:pat subject:"big deal"').fts).toBe(
      'sender : "nova"* recipients : "pat"* subject : "big deal"'
    )
  })

  it('handles exclusions only when something positive is present', () => {
    expect(parseQuery('rate -spam').fts).toBe('"rate"* NOT "spam"*')
    expect(parseQuery('-spam').fts).toBeNull()
  })

  it('neutralizes FTS syntax so user text cannot break the query', () => {
    for (const q of ['AND OR NOT', 'a" OR "b', 'NEAR(a b)', '(((', 'x*', '^foo', 'col:val', '""']) {
      expect(() => parseQuery(q)).not.toThrow()
    }
    expect(parseQuery('AND').fts).toBe('"AND"*') // a literal word, not an operator
    expect(parseQuery('a" OR "b').fts).not.toMatch(/OR "b"$/)
  })

  it('reads filters', () => {
    const p = parseQuery('is:unread is:flagged has:attachment account:Work in:Sent before:2026-10-25 after:2026/10/01')
    expect(p).toMatchObject({
      fts: null,
      is: ['unread', 'starred'],
      hasAttachment: true,
      account: ['work'],
      inFolder: ['sent']
    })
    expect(p.before).toBe(new Date(2026, 9, 25).getTime())
    expect(p.after).toBe(new Date(2026, 9, 1).getTime())
  })

  it('ignores unknown or malformed operators instead of failing', () => {
    expect(parseQuery('is:weird has:nothing before:soon').fts).toBeNull()
    expect(parseQuery('re: hello').fts).toBe('"hello"*')
  })
})

describe('buildSearch', () => {
  it('skips Trash and Junk unless a folder is asked for', () => {
    expect(buildSearch(parseQuery('hello')).sql).toContain("NOT IN ('trash', 'junk')")
    expect(buildSearch(parseQuery('hello in:trash')).sql).not.toContain("NOT IN ('trash', 'junk')")
  })
})

// ---- against a real database -----------------------------------------------------------

const input = (email: string, name: string): ImapAccountInput => ({
  email,
  displayName: name,
  username: 'u',
  password: 'p',
  imap: { host: 'h', port: 993, security: 'tls' },
  smtp: { host: 'h', port: 465, security: 'tls' }
})

const msg = (uid: number, over: Partial<FetchedMessage>): FetchedMessage => ({
  uid,
  messageId: `<m${uid}@x>`,
  fromName: 'Someone',
  fromAddr: 'someone@x.example',
  to: 'me@x.example',
  subject: 'Hello',
  date: Date.UTC(2026, 9, 20, 12) + uid * 3600e3,
  flags: [],
  refs: [],
  ...over
})

describe('MailStore.search', () => {
  let store: MailStore
  let a: string
  let inbox: string
  let trash: string
  let sentB: string
  let work: string

  beforeEach(() => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    store = new MailStore(db)
    a = store.addAccount(input('me@home.example', 'Home'), 'imap').id
    work = store.addAccount(input('me@work.example', 'Work'), 'imap').id
    inbox = store.upsertFolder(a, { path: 'INBOX', name: 'Inbox', role: 'inbox' })
    trash = store.upsertFolder(a, { path: 'Trash', name: 'Trash', role: 'trash' })
    sentB = store.upsertFolder(work, { path: 'Sent', name: 'Sent', role: 'sent' })
    store.applyFetched(
      a,
      inbox,
      [
        msg(1, { fromName: 'Nova Energy', fromAddr: 'partners@nova.example', subject: 'Q4 campaign brief', flags: [] }),
        msg(2, { fromName: 'Dana', fromAddr: 'dana@z.example', subject: 'Lunch?', flags: ['\\Seen', '\\Flagged'] }),
        msg(3, { fromName: 'Nova Energy', fromAddr: 'partners@nova.example', subject: 'Invoice 2291 overdue', flags: ['\\Seen'] })
      ],
      null
    )
    store.applyFetched(a, trash, [msg(9, { fromName: 'Nova Energy', subject: 'Old Q4 draft' })], null)
    store.applyFetched(work, sentB, [msg(5, { subject: 'Re: rates', to: 'pat@y.example, nova-agent@y.example', fromName: 'Me', fromAddr: 'me@work.example' })], null)
    store.saveBody(
      `${inbox}:1`,
      { html: null, text: 'The rate is four thousand dollars. Contract attached.', to: '', cc: '', truncated: false, attachments: [{ id: '0', filename: 'brief.pdf', mime: 'application/pdf', size: 10, inline: false }] },
      'The rate'
    )
    store.saveBody(
      `${inbox}:2`,
      { html: null, text: 'Lunch at noon. See you there.', to: '', cc: '', truncated: false, attachments: [{ id: '0', filename: 'logo.png', mime: 'image/png', size: 1, inline: true }] },
      'Lunch'
    )
  })

  const ids = (q: string) => store.search(q).map((m) => m.id)

  it('finds by subject, sender, and body text, with prefix matching', () => {
    expect(ids('campaign')).toEqual([`${inbox}:1`])
    expect(ids('camp')).toEqual([`${inbox}:1`])
    // Newest first; the work Sent message matches through its recipient nova-agent@.
    expect(ids('nova')).toEqual([`${sentB}:5`, `${inbox}:3`, `${inbox}:1`])
    expect(ids('nova account:home')).toEqual([`${inbox}:3`, `${inbox}:1`])
    expect(ids('thousand')).toEqual([`${inbox}:1`]) // only in the body
    expect(ids('"four thousand"')).toEqual([`${inbox}:1`])
  })

  it('searches fields separately', () => {
    expect(ids('from:dana')).toEqual([`${inbox}:2`])
    expect(ids('subject:lunch')).toEqual([`${inbox}:2`])
    expect(ids('to:pat')).toEqual([`${sentB}:5`])
    expect(ids('subject:nova')).toEqual([]) // "Nova" is in the sender, not the subject
  })

  it('combines text with filters', () => {
    expect(ids('nova is:unread account:home')).toEqual([`${inbox}:1`])
    expect(ids('is:starred')).toEqual([`${inbox}:2`])
    expect(ids('nova -invoice account:home')).toEqual([`${inbox}:1`])
    expect(ids('account:work')).toEqual([`${sentB}:5`])
    expect(ids('in:sent')).toEqual([`${sentB}:5`])
  })

  it('counts only real attachments for has:attachment', () => {
    expect(ids('has:attachment')).toEqual([`${inbox}:1`]) // the inline logo does not count
  })

  it('hides Trash unless asked, and filters by date', () => {
    expect(ids('draft')).toEqual([])
    expect(ids('draft in:trash')).toEqual([`${trash}:9`])
    expect(ids('is:read after:2026-10-19 before:2026-10-22')).toEqual([`${inbox}:3`, `${inbox}:2`])
    expect(ids('is:read before:2026-10-19')).toEqual([])
  })

  it('stays in sync as messages change', () => {
    store.removeMessage(`${inbox}:2`)
    expect(ids('lunch')).toEqual([])
    store.setLocalFlags(`${inbox}:1`, { seen: true })
    expect(ids('is:unread nova account:home')).toEqual([])
  })

  it('returns nothing, not an error, for empty or hostile input', () => {
    expect(ids('')).toEqual([])
    expect(ids('   ')).toEqual([])
    expect(() => ids('"unterminated AND (')).not.toThrow()
    expect(() => ids('NEAR(')).not.toThrow()
  })
})
