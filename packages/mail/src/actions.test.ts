import { describe, expect, it } from 'vitest'
import { ImapClient, type Folder } from './imap'
import { applyAction, folderFor } from './actions'
import { FakeServer, type FakeFolder, type FakeMessage, type FakeOptions } from './fake-server'
import { buildMessage } from './compose'

const raw = (s: string) => `From: A <a@b.example>\r\nTo: me@x.example\r\nSubject: ${s}\r\nMessage-ID: <${s}@x>\r\n\r\nbody`
const msg = (uid: number, flags: string[] = []): FakeMessage => ({ uid, flags, raw: raw(`m${uid}`) })

const gmail = (): FakeFolder[] => [
  { path: 'INBOX', attrs: [], messages: [msg(1), msg(2), msg(3)] },
  { path: '[Gmail]/All Mail', attrs: ['\\All'], messages: [] },
  { path: '[Gmail]/Trash', attrs: ['\\Trash'], messages: [] },
  { path: '[Gmail]/Spam', attrs: ['\\Junk'], messages: [] },
  { path: '[Gmail]/Sent Mail', attrs: ['\\Sent'], messages: [] }
]

async function setup(folders: FakeFolder[], caps: string[] = ['IMAP4rev1', 'SASL-IR', 'MOVE', 'UIDPLUS']) {
  const o: FakeOptions = { user: 'u', password: 'p', capabilities: caps, folders }
  const server = new FakeServer(o)
  const client = new ImapClient(server.connect, { host: 'h', port: 993, security: 'tls', timeoutMs: 3000 })
  await client.open()
  await client.login('u', 'p')
  const list: Folder[] = await client.list()
  const uids = async (path: string) => (folders.find((f) => f.path === path)!.messages ?? []).map((m) => m.uid)
  return { server, client, list, uids }
}

describe('finding the right folder', () => {
  it('uses the archive, or All Mail on Gmail, and ignores folders that cannot be opened', async () => {
    const { list } = await setup(gmail())
    expect(folderFor(list, 'archive')?.path).toBe('[Gmail]/All Mail')
    expect(folderFor(list, 'trash')?.path).toBe('[Gmail]/Trash')
    expect(folderFor(list, 'junk')?.path).toBe('[Gmail]/Spam')
    expect(folderFor(list.map((f) => ({ ...f, selectable: false })), 'trash')).toBeNull()
    expect(folderFor(list, 'drafts')).toBeNull()
  })
})

describe('doing something to messages', () => {
  it('archives by moving, trashes, and marks spam', async () => {
    const f = gmail()
    const { client, list, uids } = await setup(f)
    expect(await applyAction(client, list, 'INBOX', [1], 'archive')).toEqual({ left: true })
    await applyAction(client, list, 'INBOX', [2], 'trash')
    await applyAction(client, list, 'INBOX', [3], 'junk')
    expect(await uids('INBOX')).toEqual([])
    expect(await uids('[Gmail]/All Mail')).toEqual([1])
    expect(await uids('[Gmail]/Trash')).toEqual([1])
    expect(await uids('[Gmail]/Spam')).toEqual([1])
  })

  it('works the same on a server without MOVE or UIDPLUS, by copying and removing', async () => {
    const f = gmail()
    const { client, list, server, uids } = await setup(f, ['IMAP4rev1', 'SASL-IR'])
    await applyAction(client, list, 'INBOX', [1, 2], 'archive')
    expect(await uids('INBOX')).toEqual([3])
    expect(await uids('[Gmail]/All Mail')).toEqual([1, 2])
    expect(server.received.some((l) => /UID COPY 1:2/.test(l))).toBe(true)
    expect(server.received.some((l) => /^A\d+ EXPUNGE$/.test(l))).toBe(true)
  })

  it('moves to Trash from the inbox, and deletes for good from Trash or Spam', async () => {
    const f = gmail()
    f[2]!.messages = [msg(7), msg(8)]
    const { client, list, uids } = await setup(f)
    await applyAction(client, list, 'INBOX', [1], 'delete')
    expect(await uids('[Gmail]/Trash')).toEqual([7, 8, 9])
    expect(await applyAction(client, list, '[Gmail]/Trash', [7], 'delete')).toEqual({ left: true })
    expect(await uids('[Gmail]/Trash')).toEqual([8, 9])
    expect(await uids('INBOX')).toEqual([2, 3])
  })

  it('only removes the messages it was asked to when the server can remove by number', async () => {
    const f = gmail()
    f[0]!.messages = [msg(1, ['\\Deleted']), msg(2), msg(3)]
    const { client, list, uids } = await setup(f)
    await applyAction(client, list, 'INBOX', [2], 'archive')
    // Message 1 was already marked deleted by someone else; removing 2 must not take it too.
    expect(await uids('INBOX')).toEqual([1, 3])
  })

  it('changes read and starred marks without moving anything', async () => {
    const f = gmail()
    const { client, list, uids } = await setup(f)
    expect(await applyAction(client, list, 'INBOX', [1, 2], 'markRead')).toEqual({ left: false })
    await applyAction(client, list, 'INBOX', [1], 'star')
    await applyAction(client, list, 'INBOX', [2], 'markUnread')
    const inbox = f[0]!.messages!
    expect(inbox.find((m) => m.uid === 1)!.flags!.sort()).toEqual(['\\Flagged', '\\Seen'])
    expect(inbox.find((m) => m.uid === 2)!.flags).toEqual([])
    await applyAction(client, list, 'INBOX', [1], 'unstar')
    expect(inbox.find((m) => m.uid === 1)!.flags).toEqual(['\\Seen'])
    expect(await uids('INBOX')).toEqual([1, 2, 3])
  })

  it('says so when the account has nowhere to put it, and does nothing for an empty list', async () => {
    const { client, list } = await setup([{ path: 'INBOX', messages: [msg(1)] }])
    await expect(applyAction(client, list, 'INBOX', [1], 'trash')).rejects.toThrow(/Trash folder/)
    await expect(applyAction(client, list, 'INBOX', [1], 'archive')).rejects.toThrow(/archive folder/)
    expect(await applyAction(client, list, 'INBOX', [], 'trash')).toEqual({ left: false })
  })

  it('does not move a message out of the folder it is meant to end up in', async () => {
    const f = gmail()
    f[2]!.messages = [msg(5)]
    const { client, list, uids } = await setup(f)
    expect(await applyAction(client, list, '[Gmail]/Trash', [5], 'trash')).toEqual({ left: false })
    expect(await uids('[Gmail]/Trash')).toEqual([5])
  })
})

describe('saving a copy of what was sent', () => {
  it('appends the message, byte for byte, with the read mark', async () => {
    const f = gmail()
    const { client } = await setup(f)
    const { raw: bytes } = buildMessage({ from: { name: 'Me', address: 'me@x.example' }, to: [{ name: '', address: 'a@y.example' }], subject: 'Sent copy ☕', text: 'Hello\n.dot line\n', date: Date.UTC(2026, 10, 3) })
    await client.append('[Gmail]/Sent Mail', bytes)
    const saved = f[4]!.messages!
    expect(saved).toHaveLength(1)
    expect(saved[0]!.flags).toEqual(['\\Seen'])
    expect(saved[0]!.raw).toBe(new TextDecoder().decode(bytes))
  })

  it('reports a folder that does not exist', async () => {
    const { client } = await setup(gmail())
    await expect(client.append('Nope', new TextEncoder().encode('x'))).rejects.toMatchObject({ kind: 'no' })
  })
})
