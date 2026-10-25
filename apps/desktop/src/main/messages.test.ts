import { beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { ImapAccountInput } from '@imc/core'
import { migrate } from './db'
import { MessageService, type RemoteMail } from './messages'
import { MailStore, type FetchedMessage } from './store'

const RAW = (subject: string, body: string, extra = '') =>
  Buffer.from(
    `From: Brand <deals@brand.example>\r\nTo: me@x.example\r\nSubject: ${subject}\r\nMessage-ID: <${subject}@x>\r\n${extra}Content-Type: text/html; charset=utf-8\r\n\r\n${body}\r\n`
  )

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
  fromName: 'Brand',
  fromAddr: 'deals@brand.example',
  to: 'me@x.example',
  subject: `Subject ${uid}`,
  date: uid * 1000,
  flags: [],
  refs: [],
  ...over
})

describe('MessageService', () => {
  let store: MailStore
  let account: string
  let inbox: string
  let remote: RemoteMail & { fetchSource: ReturnType<typeof vi.fn>; setFlags: ReturnType<typeof vi.fn> }
  let svc: MessageService

  beforeEach(() => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    store = new MailStore(db)
    account = store.addAccount(input, 'imap').id
    inbox = store.upsertFolder(account, { path: 'INBOX', name: 'Inbox', role: 'inbox' })
    remote = {
      fetchSource: vi.fn(async () => ({
        source: RAW('Hello', '<p>Hi <b>there</b></p><img src="https://t.example/p.gif">'),
        truncated: false
      })),
      setFlags: vi.fn(async () => {})
    }
    svc = new MessageService(store, remote)
  })

  it('downloads a body once, caches it, and shares concurrent requests', async () => {
    store.applyFetched(account, inbox, [msg(1)], null)
    const id = `${inbox}:1`
    await Promise.all([svc.loadBody(id), svc.loadBody(id)])
    await svc.loadBody(id)
    expect(remote.fetchSource).toHaveBeenCalledTimes(1)
    expect(remote.fetchSource).toHaveBeenCalledWith(account, 'INBOX', 1, expect.any(Number))
    const d = await svc.loadBody(id)
    expect(d).toMatchObject({ bodyState: 'ready', blockedImages: 1, snippet: 'Hi there' })
  })

  it('reports a failed download as an error state instead of throwing from open()', async () => {
    store.applyFetched(account, inbox, [msg(1)], null)
    remote.fetchSource.mockRejectedValueOnce(new Error('Offline: this message has not been downloaded yet'))
    const t = await svc.open(`${inbox}:1`)
    expect(t.messages[0]).toMatchObject({ bodyState: 'error' })
    expect(t.messages[0]?.error).toMatch(/Offline/)
  })

  it('opens a whole conversation oldest first and loads the selected and newest bodies', async () => {
    store.applyFetched(
      account,
      inbox,
      [
        msg(1, { messageId: '<a>' }),
        msg(2, { messageId: '<b>', refs: ['<a>'], subject: 'Re: Subject 1' }),
        msg(3, { messageId: '<c>', refs: ['<a>', '<b>'], subject: 'Re: Subject 1' })
      ],
      null
    )
    store.rethread(account)
    const t = await svc.open(`${inbox}:2`)
    expect(t.messages.map((m) => m.uid)).toEqual([1, 2, 3])
    expect(t.selectedId).toBe(`${inbox}:2`)
    expect(t.subject).toBe('Subject 1')
    expect(t.messages.map((m) => m.bodyState)).toEqual(['missing', 'ready', 'ready'])
    expect(store.listMessages({ folderId: inbox, limit: 10, offset: 0 })[0]?.threadSize).toBe(3)
  })

  it('applies flag changes locally and rolls back when the server refuses', async () => {
    store.applyFetched(account, inbox, [msg(1)], null)
    const id = `${inbox}:1`
    await svc.setFlags(id, { seen: true, flagged: true })
    expect(remote.setFlags).toHaveBeenCalledWith(account, 'INBOX', 1, {
      add: ['\\Seen', '\\Flagged'],
      remove: []
    })
    expect(store.getMessage(id)?.flags).toContain('\\Seen')

    remote.setFlags.mockRejectedValueOnce(new Error('Offline'))
    await expect(svc.setFlags(id, { seen: false })).rejects.toThrow('Offline')
    expect(store.getMessage(id)?.flags).toContain('\\Seen')
  })

  it('renders sanitized HTML, honouring the image choice, and null when not cached', async () => {
    store.applyFetched(account, inbox, [msg(1), msg(2)], null)
    expect(svc.render(`${inbox}:2`, { allowImages: false })).toBeNull()
    await svc.loadBody(`${inbox}:1`)
    const blocked = svc.render(`${inbox}:1`, { allowImages: false })!
    expect(blocked.html).not.toContain('t.example')
    expect(blocked.csp).not.toContain('https:')
    const allowed = svc.render(`${inbox}:1`, { allowImages: true })!
    expect(allowed.html).toContain('https://t.example/p.gif')
    expect(allowed.csp).toContain('https:')
  })

  it('remembers senders whose images are always allowed', async () => {
    store.applyFetched(account, inbox, [msg(1)], null)
    expect((await svc.loadBody(`${inbox}:1`)).imagesAllowed).toBe(false)
    svc.allowImages('Deals@Brand.example')
    expect((await svc.loadBody(`${inbox}:1`)).imagesAllowed).toBe(true)
  })
})
