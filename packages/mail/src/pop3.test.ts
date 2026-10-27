import { describe, expect, it } from 'vitest'
import { Pop3Client, syncPop3 } from './pop3'
import { MemoryCache } from './mailbox'
import { FakePop3, type FakePop3Options } from './fake-pop3'
import { parseMessage } from './message'

const raw = (subject: string, body = 'body') => `From: A <a@b.example>\r\nTo: me@x.example\r\nSubject: ${subject}\r\nDate: Tue, 3 Nov 2026 15:00:00 +0000\r\nMessage-ID: <${subject.replace(/\W/g, '')}@x>\r\n\r\n${body}`
const msgs = (...subjects: string[]) => subjects.map((s, i) => ({ uidl: `U${i + 1}`, raw: raw(s) }))
const server = (o: FakePop3Options = {}) => new FakePop3({ user: 'me', password: 'pw', messages: msgs('First', 'Second', 'Third'), ...o })
const client = (s: FakePop3, security: 'tls' | 'starttls' | 'none' = 'tls', timeoutMs = 2000) => new Pop3Client(s.connect, { host: 'pop.test', port: 995, security, timeoutMs })
const ready = async (o: FakePop3Options = {}) => {
  const s = server(o)
  const c = client(s)
  await c.open()
  await c.login('me', 'pw')
  return { s, c }
}

describe('connecting', () => {
  it('reads the greeting and signs in', async () => {
    await ready()
  })

  it('says a wrong password is a sign-in problem', async () => {
    const c = client(server())
    await c.open()
    await expect(c.login('me', 'nope')).rejects.toMatchObject({ kind: 'auth' })
  })

  it('will not send a password over a connection that is not encrypted, or let it add a command', async () => {
    const plain = client(server(), 'none')
    await plain.open()
    await expect(plain.login('me', 'pw')).rejects.toThrow(/not encrypted/)
    const c = client(server())
    await c.open()
    await expect(c.login('me\r\nDELE 1', 'pw')).rejects.toThrow(/line break/)
  })

  it('upgrades with STLS, and refuses when it is not offered', async () => {
    const s = server({ capabilities: ['USER', 'STLS'] })
    await client(s, 'starttls').open()
    expect(s.tlsStarted).toBe(true)
    await expect(client(server({ capabilities: ['USER'] }), 'starttls').open()).rejects.toThrow(/does not offer STLS/)
  })
})

describe('reading', () => {
  it('lists messages by their stable ids and sizes', async () => {
    const { c } = await ready()
    expect((await c.uidl()).map((m) => [m.n, m.id])).toEqual([[1, 'U1'], [2, 'U2'], [3, 'U3']])
    expect((await c.sizes()).get(2)).toBe(raw('Second').length)
  })

  it('downloads headers only, or the whole message exactly, including lines that start with a dot', async () => {
    const tricky = raw('Dots', '.leading dot\r\n..two dots\r\nnormal\r\n.')
    const { c } = await ready({ messages: [{ uidl: 'D1', raw: tricky }] })
    expect(new TextDecoder().decode(await c.top(1))).toBe('From: A <a@b.example>\r\nTo: me@x.example\r\nSubject: Dots\r\nDate: Tue, 3 Nov 2026 15:00:00 +0000\r\nMessage-ID: <Dots@x>\r\n\r\n')
    const whole = await c.retr(1)
    expect(new TextDecoder().decode(whole)).toBe(tricky + '\r\n')
    expect((await parseMessage(whole)).subject).toBe('Dots')
  })

  it('deletes a message when asked, and says when there is none', async () => {
    const { s, c } = await ready()
    await c.dele(2)
    expect(s.inbox.map((m) => m.uidl)).toEqual(['U1', 'U3'])
    await expect(c.retr(9)).rejects.toMatchObject({ kind: 'refused' })
    await c.quit()
    expect(s.lines.at(-1)).toBe('QUIT')
  })

  it('gives up when the server stops answering, and reports a dropped connection', async () => {
    const s = server()
    const c = client(s, 'tls', 40)
    await c.open()
    s.connect // keep the type checker happy about unused access
    const slow = new FakePop3({ user: 'me', password: 'pw' })
    const sc = client(slow, 'tls', 40)
    await sc.open()
    ;(slow as unknown as { command: (l: string) => void }).command = () => {}
    await expect(sc.login('me', 'pw')).rejects.toMatchObject({ kind: 'timeout' })
    const d = server()
    const dc = client(d)
    await dc.open()
    d.hangUp()
    await expect(dc.uidl()).rejects.toMatchObject({ kind: 'closed' })
  })
})

describe('keeping a saved copy', () => {
  it('saves new messages under numbers of its own and drops deleted ones', async () => {
    const s = server()
    const c = client(s)
    await c.open()
    await c.login('me', 'pw')
    const cache = new MemoryCache()
    expect(await syncPop3(c, cache, 'me', 'inbox', { now: () => 7 })).toEqual({ added: 3, removed: 0, flagsChanged: 0, reset: false })
    const saved = await cache.summaries('me', 'inbox')
    expect(saved.map((m) => [m.uid, m.subject, m.remoteId])).toEqual([[3, 'Third', 'U3'], [2, 'Second', 'U2'], [1, 'First', 'U1']])
    expect(saved[0]!.size).toBe(raw('Third').length)
    expect(await cache.folderState('me', 'inbox')).toEqual({ uidValidity: 1, highestUid: 3, syncedAt: 7 })

    // The server loses one and gains one: only the new one is downloaded, and the number carries on.
    s.deleted.add('U2')
    s.o.messages!.push({ uidl: 'U4', raw: raw('Fourth') })
    s.lines.length = 0
    const r = await syncPop3(c, cache, 'me', 'inbox')
    expect(r).toMatchObject({ added: 1, removed: 1 })
    expect(s.lines.filter((l) => l.startsWith('TOP'))).toHaveLength(1)
    expect((await cache.summaries('me', 'inbox')).map((m) => [m.uid, m.subject])).toEqual([[4, 'Fourth'], [3, 'Third'], [1, 'First']])
  })

  it('keeps a read mark that was set here, and takes only the newest window at first', async () => {
    const s = server({ messages: msgs('A', 'B', 'C', 'D', 'E') })
    const c = client(s)
    await c.open()
    await c.login('me', 'pw')
    const cache = new MemoryCache()
    await syncPop3(c, cache, 'me', 'inbox', { window: 2 })
    expect((await cache.summaries('me', 'inbox')).map((m) => m.subject)).toEqual(['E', 'D'])
    await cache.setFlags('me', 'inbox', new Map([[1, ['\\Seen']]]))
    await syncPop3(c, cache, 'me', 'inbox', { window: 2 })
    expect((await cache.summaries('me', 'inbox')).find((m) => m.uid === 1)!.flags).toEqual(['\\Seen'])
  })
})
