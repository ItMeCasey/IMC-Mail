import { beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { ImapAccountInput } from '@imc/core'
import { migrate } from './db'
import { MessageService, type RemoteMail } from './messages'
import { parseSource } from './parse-body'
import { sanitizeEmailHtml, textToHtml } from './render-email'
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
  fromName: 'Someone',
  fromAddr: 'someone@y.example',
  to: 'me@x.example',
  subject: `Subject ${uid}`,
  date: 1_000_000 + uid * 1000,
  flags: [],
  refs: [],
  ...over
})

const PHISH = {
  fromName: 'YouTube Copyright Team',
  fromAddr: 'copyright@youtube-copyright-team.example',
  subject: 'Final notice: your channel will be deleted within 24 hours'
}

describe('scam shield in the store', () => {
  let store: MailStore
  let acct: string
  let inbox: string
  let junk: string

  beforeEach(() => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    store = new MailStore(db)
    acct = store.addAccount(input, 'imap').id
    inbox = store.upsertFolder(acct, { path: 'INBOX', name: 'Inbox', role: 'inbox' })
    junk = store.upsertFolder(acct, { path: 'Junk', name: 'Junk', role: 'junk' })
  })

  it('rates mail on arrival from the headers alone', () => {
    store.applyFetched(acct, inbox, [msg(1, PHISH), msg(2, { fromName: 'Pat', fromAddr: 'pat@gmail.com' })], null)
    const rows = store.listMessages({ folderId: inbox, limit: 10, offset: 0 })
    expect(rows.find((r) => r.uid === 1)?.risk).toBe('danger')
    expect(rows.find((r) => r.uid === 2)?.risk).toBe('none')
  })

  it('sharpens the verdict from the body: links, attachments and reply-to', () => {
    store.applyFetched(acct, inbox, [msg(1, { fromName: 'Nova', fromAddr: 'jo@nova.example', subject: 'Sponsorship brief' })], null)
    expect(store.getMessage(`${inbox}:1`)?.risk).toBe('none')
    store.saveBody(
      `${inbox}:1`,
      {
        html: null,
        text: 'Please see the attached brief.',
        to: '',
        cc: '',
        truncated: false,
        attachments: [{ id: '0', filename: 'Brief.pdf.exe', mime: 'application/octet-stream', size: 5, inline: false }],
        replyTo: 'jo@elsewhere.example',
        authResults: 'dmarc=fail',
        links: [{ href: 'https://evil.example/x', text: 'https://nova.example/brief' }]
      },
      'Please see'
    )
    const m = store.getMessage(`${inbox}:1`)!
    expect(m.risk).toBe('danger')
    const codes = (JSON.parse(m.riskReasons) as { code: string }[]).map((r) => r.code)
    expect(codes).toEqual(expect.arrayContaining(['risky-attachment', 'link-mismatch', 'reply-to']))
  })

  it('"mark as safe" silences a message everywhere, and can be undone', () => {
    store.applyFetched(acct, inbox, [msg(1, PHISH)], null)
    expect(store.viewCounts().suspicious).toBe(1)
    store.setRiskSafe(`${inbox}:1`, true)
    expect(store.listMessages({ folderId: inbox, limit: 5, offset: 0 })[0]?.risk).toBe('none')
    expect(store.viewCounts().suspicious).toBe(0)
    expect(store.search('is:suspicious')).toEqual([])
    store.setRiskSafe(`${inbox}:1`, false)
    expect(store.listMessages({ folderId: inbox, limit: 5, offset: 0 })[0]?.risk).toBe('danger')
  })

  it('the Suspicious view and search list flagged mail, but not what is already in Junk', () => {
    store.applyFetched(acct, inbox, [msg(1, PHISH), msg(2)], null)
    store.applyFetched(acct, junk, [msg(9, PHISH)], null)
    expect(store.listMessages({ view: 'suspicious', limit: 10, offset: 0 }).map((m) => m.uid)).toEqual([1])
    expect(store.viewCounts().suspicious).toBe(1)
    expect(store.search('is:suspicious in:inbox').map((m) => m.uid)).toEqual([1])
  })

  it('backfills mail cached before the shield existed', () => {
    store.applyFetched(acct, inbox, [msg(1, PHISH)], null)
    ;(store as unknown as { db: Database.Database }).db.exec('UPDATE message SET risk = NULL, category = NULL')
    expect(store.backfillCategories()).toBe(1)
    expect(store.getMessage(`${inbox}:1`)?.risk).toBe('danger')
  })
})

describe('defanged links', () => {
  it('removes every destination but keeps the visible text', () => {
    const { html } = sanitizeEmailHtml('<p>Click <a href="https://evil.example/login">here to appeal</a></p>', {
      allowImages: false,
      defangLinks: true
    })
    expect(html).not.toContain('evil.example')
    expect(html).not.toContain('href')
    expect(html).toContain('here to appeal')
    expect(html).toContain('data-defanged')
  })
  it('leaves links alone otherwise, and defangs plain-text urls too', () => {
    expect(sanitizeEmailHtml('<a href="https://ok.example">x</a>', { allowImages: false }).html).toContain('href="https://ok.example"')
    expect(textToHtml('see https://evil.example/p now', { defangLinks: true })).not.toContain('href')
  })
})

describe('MessageService with a dangerous message', () => {
  const RAW = (html: string) =>
    Buffer.from(
      `From: YouTube Team <copyright@youtube-team-support.example>\r\nTo: me@x.example\r\nSubject: Final notice\r\nReply-To: scammer@gmail.com\r\nAuthentication-Results: mx; dmarc=fail\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n`
    )

  async function setup() {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    const store = new MailStore(db)
    const acct = store.addAccount(input, 'imap').id
    const inbox = store.upsertFolder(acct, { path: 'INBOX', name: 'Inbox', role: 'inbox' })
    store.applyFetched(acct, inbox, [msg(1, { fromName: 'YouTube Team', fromAddr: 'copyright@youtube-team-support.example', subject: 'Final notice' })], null)
    const remote: RemoteMail = {
      fetchSource: vi.fn(async () => ({
        source: RAW('<p>Your channel will be deleted within 24 hours. <a href="https://bit.ly/appeal">https://youtube.com/appeal</a></p>'),
        truncated: false
      })),
      setFlags: vi.fn(),
      moveMessage: vi.fn(),
      deleteMessage: vi.fn()
    }
    return { svc: new MessageService(store, remote), store, id: `${inbox}:1` }
  }

  it('parses reply-to, authentication results and links from a real message', async () => {
    const p = await parseSource(RAW('<a href="https://x.example/a">text</a>'))
    expect(p.replyTo).toContain('scammer@gmail.com')
    expect(p.authResults).toContain('dmarc=fail')
    expect(p.links).toEqual([{ href: 'https://x.example/a', text: 'text' }])
  })

  it('reports reasons in the detail, defangs links until allowed, and honours "safe"', async () => {
    const { svc, id } = await setup()
    const d = await svc.loadBody(id)
    expect(d.risk.level).toBe('danger')
    expect(d.risk.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(['name-spoof', 'link-mismatch']))
    expect(d.riskSafe).toBe(false)

    const locked = svc.render(id, { allowImages: false })!
    expect(locked.html).not.toContain('bit.ly')
    expect(locked.html).toContain('data-defanged')

    const opened = svc.render(id, { allowImages: false, allowLinks: true })!
    expect(opened.html).toContain('https://bit.ly/appeal')

    svc.markSafe(id, true)
    expect((await svc.loadBody(id)).risk.level).toBe('none')
    expect(svc.render(id, { allowImages: false })!.html).toContain('https://bit.ly/appeal')
  })
})
