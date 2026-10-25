import { beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { ImapAccountInput } from '@imc/core'
import { migrate } from './db'
import { MessageService, type RemoteMail } from './messages'
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
  fromName: 'Brand',
  fromAddr: 'deals@brand.example',
  to: 'me@x.example',
  subject: `Subject ${uid}`,
  date: uid * 1000,
  flags: [],
  refs: [],
  ...over
})

describe('MessageService.act', () => {
  let store: MailStore
  let account: string
  let inbox: string
  let remote: RemoteMail & { moveMessage: ReturnType<typeof vi.fn>; deleteMessage: ReturnType<typeof vi.fn> }
  let moved: ReturnType<typeof vi.fn>
  let svc: MessageService

  beforeEach(() => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    store = new MailStore(db)
    account = store.addAccount(input, 'imap').id
    inbox = store.upsertFolder(account, { path: 'INBOX', name: 'Inbox', role: 'inbox' })
    remote = {
      fetchSource: vi.fn(),
      setFlags: vi.fn(),
      moveMessage: vi.fn(async () => {}),
      deleteMessage: vi.fn(async () => {})
    }
    moved = vi.fn()
    svc = new MessageService(store, remote, moved as (id: string) => void)
  })

  const role = (path: string, r: 'archive' | 'trash' | 'junk' | 'all') =>
    store.upsertFolder(account, { path, name: path, role: r })
  const id = (folder: string, uid: number) => `${folder}:${uid}`

  it('archives to the Archive folder, then drops the message from the cache', async () => {
    role('Archive', 'archive')
    store.applyFetched(account, inbox, [msg(1)], null)
    await svc.act(id(inbox, 1), 'archive')
    expect(remote.moveMessage).toHaveBeenCalledWith(account, 'INBOX', 1, 'Archive')
    expect(store.getMessage(id(inbox, 1))).toBeUndefined()
    expect(moved).toHaveBeenCalledWith(account)
  })

  it('falls back to All Mail (Gmail) and refuses when there is no archive at all', async () => {
    role('[Gmail]/All Mail', 'all')
    store.applyFetched(account, inbox, [msg(1), msg(2)], null)
    await svc.act(id(inbox, 1), 'archive')
    expect(remote.moveMessage).toHaveBeenCalledWith(account, 'INBOX', 1, '[Gmail]/All Mail')
    store.pruneFolders(account, ['INBOX'])
    await expect(svc.act(id(inbox, 2), 'archive')).rejects.toThrow(/no Archive folder/)
  })

  it('moves to Trash and Junk, and refuses to do either twice', async () => {
    role('Trash', 'trash')
    role('Junk', 'junk')
    store.applyFetched(account, inbox, [msg(1), msg(2)], null)
    await svc.act(id(inbox, 1), 'trash')
    expect(remote.moveMessage).toHaveBeenLastCalledWith(account, 'INBOX', 1, 'Trash')
    await svc.act(id(inbox, 2), 'junk')
    expect(remote.moveMessage).toHaveBeenLastCalledWith(account, 'INBOX', 2, 'Junk')

    const trash = store.findFolderByRole(account, 'trash')!
    store.applyFetched(account, trash.id, [msg(9)], null)
    await expect(svc.act(id(trash.id, 9), 'trash')).rejects.toThrow(/Already in Trash/)
  })

  it('moves only into another folder of the same account', async () => {
    const other = store.addAccount({ ...input, email: 'b@x.example' }, 'imap').id
    const foreign = store.upsertFolder(other, { path: 'Work', name: 'Work', role: null })
    const mine = store.upsertFolder(account, { path: 'Work', name: 'Work', role: null })
    store.applyFetched(account, inbox, [msg(1)], null)
    await expect(svc.act(id(inbox, 1), 'move', foreign)).rejects.toThrow(/same account/)
    await expect(svc.act(id(inbox, 1), 'move', inbox)).rejects.toThrow(/already in that folder/)
    await expect(svc.act(id(inbox, 1), 'move')).rejects.toThrow(/same account/)
    await svc.act(id(inbox, 1), 'move', mine)
    expect(remote.moveMessage).toHaveBeenCalledWith(account, 'INBOX', 1, 'Work')
  })

  it('erases for good only from Trash or Junk', async () => {
    role('Trash', 'trash')
    store.applyFetched(account, inbox, [msg(1)], null)
    await expect(svc.act(id(inbox, 1), 'deleteForever')).rejects.toThrow(/Trash or Junk/)
    const trash = store.findFolderByRole(account, 'trash')!
    store.applyFetched(account, trash.id, [msg(5)], null)
    await svc.act(id(trash.id, 5), 'deleteForever')
    expect(remote.deleteMessage).toHaveBeenCalledWith(account, 'Trash', 5)
    expect(store.getMessage(id(trash.id, 5))).toBeUndefined()
  })

  it('leaves the message in place when the server refuses', async () => {
    role('Archive', 'archive')
    store.applyFetched(account, inbox, [msg(1)], null)
    remote.moveMessage.mockRejectedValueOnce(new Error('Offline: reconnect to move this message'))
    await expect(svc.act(id(inbox, 1), 'archive')).rejects.toThrow(/Offline/)
    expect(store.getMessage(id(inbox, 1))).toBeDefined()
    expect(moved).not.toHaveBeenCalled()
  })

  it('shrinks a conversation when one of its messages leaves', async () => {
    role('Archive', 'archive')
    store.applyFetched(
      account,
      inbox,
      [msg(1, { messageId: '<a>' }), msg(2, { messageId: '<b>', refs: ['<a>'], subject: 'Re: Subject 1' })],
      null
    )
    store.rethread(account)
    expect(store.listMessages({ folderId: inbox, limit: 5, offset: 0 })[0]?.threadSize).toBe(2)
    await svc.act(id(inbox, 2), 'archive')
    expect(store.listMessages({ folderId: inbox, limit: 5, offset: 0 })[0]?.threadSize).toBe(1)
  })
})

describe('undoing a move', () => {
  it('hands back how to undo, finds the message by Message-ID, and cannot undo a permanent delete', async () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    const store = new MailStore(db)
    const acct = store.addAccount({ email: 'me@x.example', username: 'me', imap: { host: 'h', port: 993, security: 'tls' }, smtp: { host: 'h', port: 465, security: 'tls' } }, 'imap').id
    const inbox = store.upsertFolder(acct, { path: 'INBOX', name: 'Inbox', role: 'inbox' })
    store.upsertFolder(acct, { path: 'Archive', name: 'Archive', role: 'archive' })
    const trash = store.upsertFolder(acct, { path: 'Trash', name: 'Trash', role: 'trash' })
    store.applyFetched(acct, inbox, [{ uid: 1, messageId: '<a@x>', fromName: 'A', fromAddr: 'a@b.example', to: 'me@x.example', subject: 's', date: 1, flags: [], refs: [] }], null)
    store.applyFetched(acct, trash, [{ uid: 2, messageId: '<t@x>', fromName: 'A', fromAddr: 'a@b.example', to: 'me@x.example', subject: 't', date: 2, flags: [], refs: [] }], null)
    const remote = { fetchSource: vi.fn(), setFlags: vi.fn(), moveMessage: vi.fn(), deleteMessage: vi.fn(), moveByMessageId: vi.fn() }
    const svc = new MessageService(store, remote)
    const r = await svc.act(`${inbox}:1`, 'archive')
    expect(r.undo).toEqual({ accountId: acct, messageId: '<a@x>', from: 'Archive', to: 'INBOX', label: 'Archived' })
    await svc.undoMove(r.undo!)
    expect(remote.moveByMessageId).toHaveBeenCalledWith(acct, 'Archive', '<a@x>', 'INBOX')
    expect((await svc.act(`${trash}:2`, 'deleteForever')).undo).toBeNull()
  })
})
