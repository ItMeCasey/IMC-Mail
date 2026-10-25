import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { simpleParser, type ParsedMail } from 'mailparser'
import { SMTPServer } from 'smtp-server'
import type { Draft, ImapAccountInput } from '@imc/core'
import { bareAddress, ComposeService, htmlToText, SmtpMailer, UNDO_MS } from './compose'
import { migrate } from './db'
import { MailStore, type BodyRow, type FetchedMessage } from './store'

interface Received {
  mail: ParsedMail
  from: string
  rcpt: string[]
}

let server: SMTPServer
let port: number
let received: Received[]

beforeEach(async () => {
  received = []
  server = new SMTPServer({
    authOptional: false,
    allowInsecureAuth: true,
    disabledCommands: ['STARTTLS'],
    logger: false,
    onAuth(auth, _s, cb) {
      if (auth.username === 'me' && auth.password === 'pw') cb(null, { user: 'me' })
      else cb(new Error('Invalid login: 535 authentication failed'))
    },
    onData(stream, session, cb) {
      const chunks: Buffer[] = []
      stream.on('data', (c: Buffer) => chunks.push(c))
      stream.on('end', () => {
        void simpleParser(Buffer.concat(chunks)).then((mail) => {
          received.push({
            mail,
            from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
            rcpt: session.envelope.rcptTo.map((r) => r.address)
          })
          cb()
        })
      })
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.server.address() as { port: number }).port
})
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

const input = (email: string, pass = 'pw'): ImapAccountInput => ({
  email,
  displayName: 'Casey',
  username: 'me',
  password: pass,
  imap: { host: '127.0.0.1', port: 1, security: 'tls' },
  smtp: { host: '127.0.0.1', port, security: 'none' }
})

const msg = (uid: number, over: Partial<FetchedMessage> = {}): FetchedMessage => ({
  uid,
  messageId: `<m${uid}@x>`,
  fromName: 'Nova',
  fromAddr: 'partners@nova.example',
  to: 'me@x.example',
  subject: 'Q4 brief',
  date: Date.UTC(2026, 9, 24, 12),
  flags: [],
  refs: [],
  ...over
})

function setup(opts: { pass?: string; provider?: 'imap' | 'gmail' } = {}) {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  const store = new MailStore(db)
  const account = store.addAccount(input('me@x.example', opts.pass), opts.provider ?? 'imap')
  const inbox = store.upsertFolder(account.id, { path: 'INBOX', name: 'Inbox', role: 'inbox' })
  const sent = store.upsertFolder(account.id, { path: 'Sent', name: 'Sent', role: 'sent' })
  let clock = 1_000_000
  const dir = mkdtempSync(join(tmpdir(), 'imc-outbox-'))
  const append = vi.fn(async () => {})
  const onSent = vi.fn()
  const onChange = vi.fn()
  const bodies = new Map<string, BodyRow>()
  const svc = new ComposeService(
    store,
    new SmtpMailer({ get: async () => ({ pass: 'pw' }) }, append),
    {
      outboxDir: dir,
      ensureBody: async (id) => bodies.get(id) ?? { html: null, text: '', to: '', cc: '', attachments: [], truncated: false },
      onChange,
      onSent,
      now: () => clock
    }
  )
  return { db, store, account, inbox, sent, svc, dir, append, onSent, onChange, bodies, advance: (ms: number) => (clock += ms) }
}

const draft = (accountId: string, over: Partial<Draft> = {}): Draft => ({
  accountId,
  to: ['Pat <pat@y.example>'],
  cc: ['cc@y.example'],
  bcc: ['hidden@y.example'],
  subject: 'Hello',
  html: '<p>Hi <b>Pat</b></p>',
  attachments: [],
  ...over
})

describe('sending', () => {
  it('queues, waits out the undo window, then delivers over real SMTP', async () => {
    const t = setup()
    const file = join(t.dir, 'brief.txt')
    writeFileSync(file, 'attachment body')
    const att = await t.svc.vetFiles([file])

    const { outboxId, sendAt } = await t.svc.send(
      draft(t.account.id, { attachments: att, inReplyTo: '<a@x>', references: ['<z@x>', '<a@x>'] })
    )
    expect(sendAt).toBe(1_000_000 + UNDO_MS)
    expect(t.svc.list()[0]).toMatchObject({ id: outboxId, state: 'queued' })

    await t.svc.tick()
    expect(received).toHaveLength(0) // still inside the undo window

    t.advance(UNDO_MS + 1)
    await t.svc.tick()
    expect(received).toHaveLength(1)
    const { mail, from, rcpt } = received[0]!
    expect(from).toBe('me@x.example')
    expect(rcpt.sort()).toEqual(['cc@y.example', 'hidden@y.example', 'pat@y.example'])
    expect(mail.subject).toBe('Hello')
    expect(mail.from?.text).toContain('me@x.example')
    expect(mail.to).toBeDefined()
    expect(mail.headers.get('bcc')).toBeUndefined() // Bcc is envelope-only
    expect(mail.html).toContain('<b>Pat</b>')
    expect(mail.text).toContain('Hi Pat')
    expect(mail.inReplyTo).toBe('<a@x>')
    expect(mail.references).toEqual(['<z@x>', '<a@x>'])
    expect(mail.attachments[0]).toMatchObject({ filename: 'brief.txt' })
    expect(mail.attachments[0]?.content.toString()).toBe('attachment body')

    expect(t.svc.list()[0]?.state).toBe('sent')
    expect(t.onSent).toHaveBeenCalledWith(t.account.id)
    expect(t.append).toHaveBeenCalledTimes(1) // plain IMAP: copy goes to Sent
    expect(t.append.mock.calls[0]).toEqual([t.account.id, 'Sent', expect.any(Buffer)])
  })

  it('does not copy to Sent for providers that file sent mail themselves', async () => {
    const t = setup({ provider: 'gmail' })
    await t.svc.send(draft(t.account.id))
    t.advance(UNDO_MS + 1)
    await t.svc.tick()
    expect(received).toHaveLength(1)
    expect(t.append).not.toHaveBeenCalled()
  })

  it('still reports success when the Sent copy fails', async () => {
    const t = setup()
    t.append.mockRejectedValueOnce(new Error('append failed'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await t.svc.send(draft(t.account.id))
    t.advance(UNDO_MS + 1)
    await t.svc.tick()
    expect(t.svc.list()[0]?.state).toBe('sent')
  })

  it('undo returns the draft and nothing is sent', async () => {
    const t = setup()
    const { outboxId } = await t.svc.send(draft(t.account.id, { subject: 'Oops' }))
    const back = t.svc.undo(outboxId)
    expect(back?.subject).toBe('Oops')
    expect(t.svc.list()).toHaveLength(0)
    t.advance(UNDO_MS + 1)
    await t.svc.tick()
    expect(received).toHaveLength(0)
  })

  it('cannot undo a message that already went out', async () => {
    const t = setup()
    const { outboxId } = await t.svc.send(draft(t.account.id))
    t.advance(UNDO_MS + 1)
    await t.svc.tick()
    expect(t.svc.undo(outboxId)).toBeNull()
  })

  it('marks a rejected login as failed, keeps it, and lets you edit it again', async () => {
    const t = setup()
    t.svc['mailer'] = new SmtpMailer({ get: async () => ({ pass: 'wrong' }) })
    const { outboxId } = await t.svc.send(draft(t.account.id))
    t.advance(UNDO_MS + 1)
    await t.svc.tick()
    const item = t.svc.list()[0]!
    expect(item.state).toBe('failed')
    expect(item.error).toMatch(/Invalid login|authentication/i)
    expect(received).toHaveLength(0)
    expect(t.svc.undo(outboxId)?.subject).toBe('Hello')
  })

  it('sends items that were queued before a restart', async () => {
    const t = setup()
    await t.svc.send(draft(t.account.id))
    const fresh = new ComposeService(t.store, new SmtpMailer({ get: async () => ({ pass: 'pw' }) }), {
      outboxDir: t.dir,
      ensureBody: async () => ({ html: null, text: '', to: '', cc: '', attachments: [], truncated: false }),
      onChange: () => {},
      onSent: () => {},
      now: () => 1_000_000 + UNDO_MS + 5
    })
    await fresh.tick()
    expect(received).toHaveLength(1)
  })
})

describe('what the recipient sees', () => {
  it('keeps display names in the To header and the file name you attached', async () => {
    const t = setup()
    const file = join(t.dir, 'brief.txt')
    writeFileSync(file, 'body')
    const [att] = await t.svc.vetFiles([file])
    await t.svc.send(draft(t.account.id, { to: ['Pat Lee <pat@y.example>'], attachments: [{ ...att!, filename: 'Media Kit.txt' }] }))
    t.advance(UNDO_MS + 1)
    await t.svc.tick()
    const { mail, rcpt } = received[0]!
    expect(mail.to).toBeDefined()
    expect(JSON.stringify(mail.to)).toContain('Pat Lee')
    expect(rcpt).toContain('pat@y.example') // the envelope still gets the bare address
    expect(mail.attachments[0]?.filename).toBe('Media Kit.txt')
  })

  it('hands the draft back with the names as typed', async () => {
    const t = setup()
    const { outboxId } = await t.svc.send(draft(t.account.id, { to: ['Pat Lee <pat@y.example>'] }))
    expect(t.svc.undo(outboxId)?.to).toEqual(['Pat Lee <pat@y.example>'])
  })
})

describe('scheduled send', () => {
  const HOUR = 3600e3

  it('waits for the chosen time, shows as scheduled, and sends once it arrives', async () => {
    const t = setup()
    const at = 1_000_000 + 20 * HOUR
    const { sendAt } = await t.svc.send(draft(t.account.id), { sendAt: at })
    expect(sendAt).toBe(at)
    expect(t.svc.list()[0]).toMatchObject({ state: 'queued', scheduled: true, sendAt: at })

    t.advance(UNDO_MS * 3) // far past the undo window, still not time
    await t.svc.tick()
    expect(received).toHaveLength(0)

    t.advance(20 * HOUR)
    await t.svc.tick()
    expect(received).toHaveLength(1)
    expect(received[0]?.mail.subject).toBe('Hello')
    expect(t.svc.list()).toEqual([]) // sent rows are tidied away a minute later
  })

  it('can be cancelled back into a draft before it goes out', async () => {
    const t = setup()
    const { outboxId } = await t.svc.send(draft(t.account.id, { subject: 'Later' }), { sendAt: 1_000_000 + 5 * HOUR })
    expect(t.svc.undo(outboxId)?.subject).toBe('Later')
    t.advance(6 * HOUR)
    await t.svc.tick()
    expect(received).toHaveLength(0)
  })

  it('a time in the past or inside the undo window behaves like a normal send', async () => {
    const t = setup()
    const past = await t.svc.send(draft(t.account.id), { sendAt: 5 })
    expect(past.sendAt).toBe(1_000_000 + UNDO_MS)
    expect(t.svc.list()[0]?.scheduled).toBe(false)
    const soon = await t.svc.send(draft(t.account.id), { sendAt: 1_000_000 + 2000 })
    expect(soon.sendAt).toBe(1_000_000 + UNDO_MS)
  })

  it('refuses a date more than a year away', async () => {
    const t = setup()
    await expect(t.svc.send(draft(t.account.id), { sendAt: 1_000_000 + 400 * 24 * HOUR })).rejects.toThrow(/year/)
  })

  it('a scheduled message survives a restart and goes out when the app is next opened', async () => {
    const t = setup()
    await t.svc.send(draft(t.account.id), { sendAt: 1_000_000 + 3 * HOUR })
    const later = new ComposeService(t.store, new SmtpMailer({ get: async () => ({ pass: 'pw' }) }), {
      outboxDir: t.dir,
      ensureBody: async () => ({ html: null, text: '', to: '', cc: '', attachments: [], truncated: false }),
      onChange: () => {},
      onSent: () => {},
      now: () => 1_000_000 + 9 * HOUR // opened hours after it was due
    })
    await later.tick()
    expect(received).toHaveLength(1)
  })
})

describe('validation', () => {
  it('requires a recipient and valid addresses', async () => {
    const t = setup()
    await expect(t.svc.send(draft(t.account.id, { to: [], cc: [], bcc: [] }))).rejects.toThrow(/at least one recipient/)
    await expect(t.svc.send(draft(t.account.id, { to: ['not an address'] }))).rejects.toThrow(/not a valid email/)
    await expect(t.svc.send(draft('missing'))).rejects.toThrow(/Choose an account/)
  })

  it('refuses attachments over 25 MB', async () => {
    const t = setup()
    const big = join(t.dir, 'big.bin')
    writeFileSync(big, Buffer.alloc(26 * 1024 * 1024))
    await expect(t.svc.vetFiles([big])).rejects.toThrow(/larger than 25 MB/)
    await expect(t.svc.vetFiles([t.dir])).rejects.toThrow(/not a file/)
  })
})

describe('drafts and contacts', () => {
  it('saves, lists, loads, and discards drafts; sending removes the draft', async () => {
    const t = setup()
    const { id } = t.svc.saveDraft(draft(t.account.id, { subject: 'WIP' }))
    expect(t.svc.listDrafts()[0]).toMatchObject({ id, subject: 'WIP' })
    expect(t.svc.loadDraft(id)?.subject).toBe('WIP')
    t.svc.saveDraft({ ...draft(t.account.id, { subject: 'WIP 2' }), id })
    expect(t.svc.listDrafts()).toHaveLength(1)

    await t.svc.send({ ...draft(t.account.id), id })
    expect(t.svc.loadDraft(id)).toBeNull()

    const other = t.svc.saveDraft(draft(t.account.id))
    t.svc.discardDraft(other.id)
    expect(t.svc.listDrafts()).toHaveLength(0)
  })

  it('suggests senders by volume and recipients of sent mail', () => {
    const t = setup()
    t.store.applyFetched(
      t.account.id,
      t.inbox,
      [
        msg(1, { fromName: 'Nova Energy', fromAddr: 'partners@nova.example' }),
        msg(2, { fromName: 'Nova Energy', fromAddr: 'partners@nova.example' }),
        msg(3, { fromName: 'Novak', fromAddr: 'novak@z.example' })
      ],
      null
    )
    t.store.applyFetched(t.account.id, t.sent, [msg(1, { to: 'nova-agent@a.example, other@b.example' })], null)
    const names = t.svc.contacts('nova').map((c) => c.address)
    expect(names[0]).toBe('partners@nova.example')
    expect(names).toContain('novak@z.example')
    expect(names).toContain('nova-agent@a.example')
    expect(names).not.toContain('other@b.example')
    expect(t.svc.contacts('n')).toEqual([])
  })
})

describe('replyContext', () => {
  it('replies to the sender with threading headers and a quoted original', async () => {
    const t = setup()
    t.store.applyFetched(t.account.id, t.inbox, [msg(1, { refs: ['<root@x>'] })], null)
    t.bodies.set(`${t.inbox}:1`, { html: '<p>Brief <b>attached</b></p>', text: '', to: 'me@x.example', cc: '', attachments: [], truncated: false })
    const c = await t.svc.replyContext(`${t.inbox}:1`, 'reply')
    expect(c).toMatchObject({
      accountId: t.account.id,
      to: ['Nova <partners@nova.example>'],
      cc: [],
      subject: 'Re: Q4 brief',
      inReplyTo: '<m1@x>',
      references: ['<root@x>', '<m1@x>']
    })
    expect(c.html).toContain('<blockquote>')
    expect(c.html).toContain('Brief <b>attached</b>')
    expect(c.html).toContain('wrote:')
  })

  it('reply-all drops your own addresses and duplicates', async () => {
    const t = setup()
    t.store.applyFetched(t.account.id, t.inbox, [msg(1, { subject: 'Re: Q4 brief' })], null)
    t.bodies.set(`${t.inbox}:1`, {
      html: null,
      text: 'hi',
      to: 'me@x.example, Pat <pat@y.example>, partners@nova.example',
      cc: 'Lee <lee@y.example>, me@x.example',
      attachments: [],
      truncated: false
    })
    const c = await t.svc.replyContext(`${t.inbox}:1`, 'replyAll')
    expect(c.subject).toBe('Re: Q4 brief')
    expect(c.to).toEqual(['Nova <partners@nova.example>'])
    expect(c.cc.sort()).toEqual(['Lee <lee@y.example>', 'Pat <pat@y.example>'])
  })

  it('replying to your own message goes to its recipients', async () => {
    const t = setup()
    t.store.applyFetched(
      t.account.id,
      t.sent,
      [msg(1, { fromName: 'Casey', fromAddr: 'me@x.example', to: 'pat@y.example' })],
      null
    )
    t.bodies.set(`${t.sent}:1`, { html: null, text: 'x', to: 'pat@y.example', cc: '', attachments: [], truncated: false })
    const c = await t.svc.replyContext(`${t.sent}:1`, 'reply')
    expect(c.to).toEqual(['pat@y.example'])
  })

  it('forwards with no recipients and no threading', async () => {
    const t = setup()
    t.store.applyFetched(t.account.id, t.inbox, [msg(1)], null)
    const c = await t.svc.replyContext(`${t.inbox}:1`, 'forward')
    expect(c).toMatchObject({ to: [], cc: [], subject: 'Fwd: Q4 brief', references: [] })
    expect(c.inReplyTo).toBeUndefined()
    expect(c.html).toContain('Forwarded message')
  })
})

describe('helpers', () => {
  it('bareAddress extracts addresses and rejects junk', () => {
    expect(bareAddress('Pat <pat@y.example>')).toBe('pat@y.example')
    expect(bareAddress('pat@y.example')).toBe('pat@y.example')
    expect(bareAddress('nope')).toBeNull()
    expect(bareAddress('a@b')).toBeNull()
  })

  it('htmlToText keeps paragraphs and decodes entities', () => {
    expect(htmlToText('<p>Tom &amp; Jerry</p><p>Line<br>two &lt;3</p>')).toBe('Tom & Jerry\n\nLine\ntwo <3')
  })
})

describe('remind me if nobody replies', () => {
  it('reports the sent message by its real Message-ID, and the reminder lands once the Sent copy syncs', async () => {
    const calls: [string, string, number][] = []
    const t = setup()
    let clock = 1_000_000
    const svc = new ComposeService(t.store, new SmtpMailer({ get: async () => ({ pass: 'pw' }) }, t.append), {
      outboxDir: t.dir,
      ensureBody: async () => ({ html: null, text: '', to: '', cc: '', attachments: [], truncated: false }),
      onChange: () => {},
      onSent: () => {},
      onFollowUp: (a, m, due) => {
        calls.push([a, m, due])
        t.store.addPendingFollowUp(a, m, due, 1_000_000)
      },
      now: () => clock
    })
    await svc.send(draft(t.account.id, { followUpDays: 3 }))
    clock += UNDO_MS + 5
    await svc.tick()
    const header = received[received.length - 1]!.mail.messageId!
    expect(calls).toEqual([[t.account.id, header, 1_000_000 + UNDO_MS + 5 + 3 * 24 * 3600 * 1000]])

    // Not in Sent yet: nothing to remind about.
    expect(t.store.followUpTick(calls[0]![2] + 1)).toEqual([])
    // The server's copy arrives with the same Message-ID.
    t.store.applyFetched(t.account.id, t.sent, [msg(5, { messageId: header, fromAddr: 'me@x.example', to: 'pat@y.example', subject: 'Hello' })], null)
    expect(t.store.followUpTick(calls[0]![2] + 1)).toEqual([`${t.sent}:5`])
  })

  it('sets no reminder unless one was asked for', async () => {
    const t = setup()
    const onFollowUp = vi.fn()
    let clock = 1_000_000
    const svc = new ComposeService(t.store, new SmtpMailer({ get: async () => ({ pass: 'pw' }) }, t.append), {
      outboxDir: t.dir, ensureBody: async () => ({ html: null, text: '', to: '', cc: '', attachments: [], truncated: false }),
      onChange: () => {}, onSent: () => {}, onFollowUp, now: () => clock
    })
    await svc.send(draft(t.account.id))
    clock += UNDO_MS + 5
    await svc.tick()
    expect(onFollowUp).not.toHaveBeenCalled()
  })
})
