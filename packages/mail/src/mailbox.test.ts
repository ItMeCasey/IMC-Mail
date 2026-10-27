import { describe, expect, it } from 'vitest'
import { ImapClient } from './imap'
import { FakeServer, type FakeFolder, type FakeMessage } from './fake-server'
import { MemoryCache, syncFolder } from './mailbox'

const raw = (subject: string) => `From: A <a@b.example>\r\nTo: me@x.example\r\nSubject: ${subject}\r\nDate: Tue, 3 Nov 2026 15:00:00 +0000\r\nMessage-ID: <${subject.replace(/\W/g, '')}@x>\r\nContent-Type: text/plain\r\n\r\nbody`
const msg = (uid: number, flags: string[] = []): FakeMessage => ({ uid, flags, raw: raw(`Message ${uid}`) })

async function setup(messages: FakeMessage[]) {
  const folder: FakeFolder = { path: 'INBOX', uidValidity: 100, messages }
  const server = new FakeServer({ user: 'u', password: 'p', folders: [folder] })
  const client = new ImapClient(server.connect, { host: 'h', port: 993, security: 'tls', timeoutMs: 3000 })
  await client.open()
  await client.login('u', 'p')
  return { server, client, folder, cache: new MemoryCache() }
}

const subjects = async (cache: MemoryCache) => (await cache.summaries('me', 'INBOX')).map((m) => m.subject)

describe('syncFolder', () => {
  it('saves the folder the first time and remembers where it got to', async () => {
    const { client, cache } = await setup([msg(1), msg(2, ['\\Seen']), msg(5)])
    const r = await syncFolder(client, cache, 'me', 'INBOX', { now: () => 1234 })
    expect(r).toEqual({ added: 3, removed: 0, flagsChanged: 0, reset: false })
    expect(await subjects(cache)).toEqual(['Message 5', 'Message 2', 'Message 1'])
    expect(await cache.folderState('me', 'INBOX')).toEqual({ uidValidity: 100, highestUid: 5, syncedAt: 1234 })
    expect((await cache.summaries('me', 'INBOX')).find((m) => m.uid === 2)!.flags).toEqual(['\\Seen'])
  })

  it('fetches only what is new the next time', async () => {
    const { server, client, folder, cache } = await setup([msg(1), msg(2)])
    await syncFolder(client, cache, 'me', 'INBOX')
    server.received.length = 0
    folder.messages!.push(msg(3))
    const r = await syncFolder(client, cache, 'me', 'INBOX')
    expect(r.added).toBe(1)
    const fetches = server.received.filter((l) => /UID FETCH/.test(l) && /HEADER\.FIELDS/.test(l))
    expect(fetches).toHaveLength(1)
    expect(fetches[0]).toMatch(/UID FETCH 3 /)
  })

  it('drops messages that were deleted on the server', async () => {
    const { client, folder, cache } = await setup([msg(1), msg(2), msg(3)])
    await syncFolder(client, cache, 'me', 'INBOX')
    folder.messages = folder.messages!.filter((m) => m.uid !== 2)
    const r = await syncFolder(client, cache, 'me', 'INBOX')
    expect(r).toMatchObject({ added: 0, removed: 1 })
    expect(await subjects(cache)).toEqual(['Message 3', 'Message 1'])
  })

  it('notices a message read or starred somewhere else', async () => {
    const { client, folder, cache } = await setup([msg(1), msg(2)])
    await syncFolder(client, cache, 'me', 'INBOX')
    folder.messages![0]!.flags = ['\\Seen', '\\Flagged']
    const r = await syncFolder(client, cache, 'me', 'INBOX')
    expect(r.flagsChanged).toBe(1)
    expect((await cache.summaries('me', 'INBOX')).find((m) => m.uid === 1)!.flags.sort()).toEqual(['\\Flagged', '\\Seen'])
    // Nothing changed: nothing reported.
    expect((await syncFolder(client, cache, 'me', 'INBOX')).flagsChanged).toBe(0)
  })

  it('starts over when the server rebuilt the folder', async () => {
    const { client, folder, cache } = await setup([msg(1), msg(2)])
    await syncFolder(client, cache, 'me', 'INBOX')
    folder.uidValidity = 999
    folder.messages = [{ uid: 1, raw: raw('Brand new one') }]
    const r = await syncFolder(client, cache, 'me', 'INBOX')
    expect(r).toMatchObject({ reset: true, added: 1 })
    expect(await subjects(cache)).toEqual(['Brand new one'])
    expect((await cache.folderState('me', 'INBOX'))!.uidValidity).toBe(999)
  })

  it('keeps only the newest window at first, and leaves older saved ones alone', async () => {
    const { client, folder, cache } = await setup(Array.from({ length: 10 }, (_, i) => msg(i + 1)))
    const r = await syncFolder(client, cache, 'me', 'INBOX', { window: 4 })
    expect(r.added).toBe(4)
    expect((await subjects(cache))[3]).toBe('Message 7')
    folder.messages!.push(msg(11))
    await syncFolder(client, cache, 'me', 'INBOX', { window: 4 })
    expect(await subjects(cache)).toEqual(['Message 11', 'Message 10', 'Message 9', 'Message 8', 'Message 7'])
  })

  it('handles an empty folder, and keeps accounts and folders apart', async () => {
    const { client, cache } = await setup([])
    expect(await syncFolder(client, cache, 'me', 'INBOX')).toEqual({ added: 0, removed: 0, flagsChanged: 0, reset: false })
    expect(await cache.folderState('me', 'INBOX')).toMatchObject({ highestUid: 0 })
    await cache.upsert('other', 'INBOX', [{ uid: 7, flags: [], internalDate: null, size: 1, from: null, to: [], cc: [], subject: 'Theirs', messageId: null, inReplyTo: null, references: [], date: null }])
    expect(await subjects(cache)).toEqual([])
    expect((await cache.summaries('other', 'INBOX')).length).toBe(1)
  })

  it('leaves the saved copy as it was when the server cannot be reached part way', async () => {
    const { server, client, folder, cache } = await setup([msg(1), msg(2)])
    await syncFolder(client, cache, 'me', 'INBOX')
    folder.messages!.push(msg(3))
    const state = await cache.folderState('me', 'INBOX')
    const wasChatty = server.hangUp.bind(server)
    // The connection drops after the search but before the headers arrive.
    const original = client.fetchSummaries.bind(client)
    client.fetchSummaries = async (uids) => {
      wasChatty()
      return original(uids)
    }
    await expect(syncFolder(client, cache, 'me', 'INBOX')).rejects.toThrow()
    expect(await cache.folderState('me', 'INBOX')).toEqual(state)
    expect(await subjects(cache)).toEqual(['Message 2', 'Message 1'])
  })
})

describe('saving a folder under another name', () => {
  it('keeps the inbox under its role name, whatever the server calls it', async () => {
    const { client, cache } = await setup([msg(1)])
    await syncFolder(client, cache, 'me', 'INBOX', { cacheKey: 'inbox' })
    expect((await cache.summaries('me', 'inbox')).length).toBe(1)
    expect((await cache.summaries('me', 'INBOX')).length).toBe(0)
  })
})
