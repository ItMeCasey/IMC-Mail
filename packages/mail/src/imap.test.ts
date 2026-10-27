import { describe, expect, it } from 'vitest'
import { ImapClient, ImapError, quote, uidSet } from './imap'
import { decodeMutf7, parseNode, ResponseReader } from './imap-parse'
import { FakeServer, type FakeFolder, type FakeOptions } from './fake-server'

const msg = (subject: string, over: { from?: string; extra?: string; body?: string } = {}) =>
  [`From: ${over.from ?? 'Brand Team <partners@brand.example>'}`, 'To: Me <me@x.example>', `Subject: ${subject}`, 'Date: Tue, 3 Nov 2026 15:00:00 +0000', 'Message-ID: <m1@brand.example>', over.extra ?? '', 'Content-Type: text/plain; charset=utf-8', '', over.body ?? 'Hello there'].filter((l, i) => l !== '' || i > 5 || false).join('\r\n')

const server = (o: FakeOptions = {}) => new FakeServer({ user: 'me@x.example', password: 'pw', token: 'tok-123', ...o })
const client = (s: FakeServer, security: 'tls' | 'starttls' | 'none' = 'tls', timeoutMs = 2000) => new ImapClient(s.connect, { host: 'imap.test', port: 993, security, timeoutMs })

const inbox: FakeFolder = {
  path: 'INBOX',
  attrs: ['\\HasNoChildren'],
  uidValidity: 77,
  messages: [
    { uid: 3, flags: ['\\Seen'], raw: msg('=?utf-8?B?U3BvbnNvcnNoaXAgw6l0w6k=?=', { from: '=?utf-8?B?SsO8cmdlbg==?= <j@brand.example>' }) },
    { uid: 5, flags: [], raw: msg('Second', { extra: 'References: <a@x> <b@x>\r\nIn-Reply-To: <b@x>' }) }
  ]
}

describe('connecting and signing in', () => {
  it('reads the greeting and the capabilities the server announces', async () => {
    const s = server({ greetingCaps: true })
    const c = client(s)
    await c.open()
    expect(s.tlsStarted).toBe(true)
    expect([...c.capabilities]).toEqual(expect.arrayContaining(['IMAP4REV1', 'SASL-IR', 'AUTH=XOAUTH2']))
  })

  it('asks for the capabilities when the greeting has none', async () => {
    const s = server()
    const c = client(s)
    await c.open()
    expect(s.received[0]).toMatch(/^A0001 CAPABILITY$/)
    expect(c.capabilities.has('SASL-IR')).toBe(true)
  })

  it('upgrades to TLS with STARTTLS, and asks again what the server offers afterwards', async () => {
    const s = server({ capabilities: ['IMAP4rev1', 'STARTTLS'] })
    const c = client(s, 'starttls')
    await c.open()
    expect(s.received.some((l) => /STARTTLS$/.test(l))).toBe(true)
    expect(s.tlsStarted).toBe(true)
    expect(s.received.filter((l) => /CAPABILITY$/.test(l)).length).toBeGreaterThanOrEqual(2)
  })

  it('refuses to go on when STARTTLS is wanted but not offered', async () => {
    const c = client(server({ capabilities: ['IMAP4rev1'] }), 'starttls')
    await expect(c.open()).rejects.toThrow(/does not offer STARTTLS/)
  })

  it('signs in with a password, and says so when it is wrong', async () => {
    const s = server()
    const c = client(s)
    await c.open()
    await c.login('me@x.example', 'pw')
    const bad = client(server())
    await bad.open()
    await expect(bad.login('me@x.example', 'nope')).rejects.toMatchObject({ kind: 'auth' })
  })

  it('will not send a password over a connection the server says is not private', async () => {
    const c = client(server({ capabilities: ['IMAP4rev1', 'LOGINDISABLED'] }), 'none')
    await c.open()
    await expect(c.login('me@x.example', 'pw')).rejects.toThrow(/unencrypted/)
  })

  it('signs in with an OAuth token in one step when the server allows it', async () => {
    const s = server()
    const c = client(s)
    await c.open()
    await c.authXoauth2('me@x.example', 'tok-123')
    expect(s.received.find((l) => l.startsWith('(decoded)'))).toBe('(decoded) user=me@x.example^Aauth=Bearer tok-123^A^A')
  })

  it('signs in with an OAuth token in two steps when the server wants a continuation', async () => {
    const s = server({ capabilities: ['IMAP4rev1', 'AUTH=XOAUTH2'] })
    const c = client(s)
    await c.open()
    await c.authXoauth2('me@x.example', 'tok-123')
    expect(s.received.some((l) => /AUTHENTICATE XOAUTH2$/.test(l))).toBe(true)
    expect(s.received.some((l) => l.startsWith('(decoded)'))).toBe(true)
  })

  it('reports a refused token as a sign-in problem, not a crash', async () => {
    for (const caps of [['IMAP4rev1', 'SASL-IR'], ['IMAP4rev1']]) {
      const c = client(server({ capabilities: caps }))
      await c.open()
      await expect(c.authXoauth2('me@x.example', 'expired')).rejects.toMatchObject({ kind: 'auth' })
    }
  })

  it('refuses sign-in details that could add a second command', async () => {
    const c = client(server())
    await c.open()
    await expect(c.login('me@x.example\r\nA9 DELETE INBOX', 'pw')).rejects.toThrow(/line break/)
    await expect(c.authXoauth2('me@x.example', 'tok\r\nX')).rejects.toThrow(/control character/)
    expect(quote('a"b\\c')).toBe('"a\\"b\\\\c"')
  })
})

describe('folders', () => {
  const folders: FakeFolder[] = [
    inbox,
    { path: 'Sent Items', attrs: ['\\HasNoChildren', '\\Sent'] },
    { path: '[Gmail]/Trash', attrs: ['\\Trash'] },
    { path: '[Gmail]', attrs: ['\\Noselect', '\\HasChildren'] },
    { path: 'Flat', delimiter: null },
    { path: 'Receipts&AOk-', attrs: [] },
    { path: 'x', listName: '{10}\r\nWith space', attrs: [] }
  ]

  it('lists folders with their special purpose and a name to show', async () => {
    const c = client(server({ folders }))
    await c.open()
    await c.login('me@x.example', 'pw')
    const list = await c.list()
    const by = (p: string) => list.find((f) => f.path === p)!
    expect(by('INBOX')).toMatchObject({ specialUse: 'inbox', name: 'INBOX', selectable: true })
    expect(by('Sent Items')).toMatchObject({ specialUse: 'sent', name: 'Sent Items' })
    expect(by('[Gmail]/Trash')).toMatchObject({ specialUse: 'trash', name: 'Trash' })
    expect(by('[Gmail]').selectable).toBe(false)
    expect(by('Flat').delimiter).toBeNull()
    expect(by('Receipts&AOk-').name).toBe('Receiptsé')
    expect(list.find((f) => f.path === 'With space')?.name).toBe('With space')
  })

  it('opens a folder and reports its counts', async () => {
    const s = server({ folders: [inbox] })
    const c = client(s)
    await c.open()
    await c.login('me@x.example', 'pw')
    expect(await c.select('INBOX')).toEqual({ exists: 2, uidValidity: 77, uidNext: 6 })
    expect(s.received.some((l) => /EXAMINE "INBOX"$/.test(l))).toBe(true)
    await expect(c.select('Nope')).rejects.toMatchObject({ kind: 'no' })
  })
})

describe('reading messages', () => {
  const ready = async (s = server({ folders: [structuredClone(inbox)] })) => {
    const c = client(s)
    await c.open()
    await c.login('me@x.example', 'pw')
    await c.select('INBOX')
    return { s, c }
  }

  it('finds the uids, then reads headers with names and subjects decoded', async () => {
    const { c } = await ready()
    expect(await c.searchUids()).toEqual([3, 5])
    const [a, b] = await c.fetchSummaries([3, 5])
    expect(a).toMatchObject({ uid: 3, flags: ['\\Seen'], subject: 'Sponsorship été', from: { name: 'Jürgen', address: 'j@brand.example' }, messageId: '<m1@brand.example>' })
    expect(a!.date).toBe(Date.UTC(2026, 10, 3, 15))
    expect(a!.to).toEqual([{ name: 'Me', address: 'me@x.example' }])
    expect(a!.size).toBeGreaterThan(50)
    expect(b).toMatchObject({ uid: 5, flags: [], subject: 'Second', inReplyTo: '<b@x>', references: ['<a@x>', '<b@x>'] })
  })

  it('asks for headers without marking anything read', async () => {
    const { s, c } = await ready()
    await c.fetchSummaries([3])
    expect(s.received.find((l) => l.includes('FETCH'))).toMatch(/BODY\.PEEK\[HEADER\.FIELDS/)
  })

  it('reads a large list in several requests', async () => {
    const many: FakeFolder = { path: 'INBOX', uidValidity: 1, messages: Array.from({ length: 250 }, (_, i) => ({ uid: i + 1, raw: msg(`Message ${i + 1}`) })) }
    const { s, c } = await ready(server({ folders: [many] }))
    const out = await c.fetchSummaries(many.messages!.map((m) => m.uid))
    expect(out).toHaveLength(250)
    expect(out[249]!.subject).toBe('Message 250')
    expect(s.received.filter((l) => l.includes('UID FETCH')).length).toBe(3)
  })

  it('returns the whole message exactly, even when its text looks like protocol', async () => {
    const trick = msg('Tricky', { body: 'line\r\n)\r\nA0099 OK fake done\r\n* 1 FETCH (UID 1)\r\n{5}\r\nend' })
    const { c } = await ready(server({ folders: [{ path: 'INBOX', messages: [{ uid: 9, raw: trick }] }] }))
    expect(new TextDecoder().decode(await c.fetchRaw(9))).toBe(trick)
  })

  it('puts a response back together however the network splits it', async () => {
    const s = server({ folders: [structuredClone(inbox)] })
    s.chunk = 7
    const { c } = await ready(s)
    const out = await c.fetchSummaries([3, 5])
    expect(out.map((x) => x.subject)).toEqual(['Sponsorship été', 'Second'])
    expect(new TextDecoder().decode(await c.fetchRaw(5))).toContain('Subject: Second')
  })

  it('says when a message is gone', async () => {
    const { c } = await ready()
    await expect(c.fetchRaw(404)).rejects.toThrow(/not on the server/)
  })

  it('changes and reads flags', async () => {
    const { s, c } = await ready()
    await c.setFlags([3, 5], { add: ['\\Seen'], remove: ['\\Flagged'] })
    expect(s.received.some((l) => /UID STORE 3,5 \+FLAGS\.SILENT \(\\Seen\)/.test(l))).toBe(true)
    expect(s.received.some((l) => /UID STORE 3,5 -FLAGS\.SILENT \(\\Flagged\)/.test(l))).toBe(true)
    expect((await c.fetchFlags([3, 5])).get(5)).toEqual(['\\Seen'])
    await c.setFlags([5], { add: ['\\Seen) UID DELETE 1:* ('] })
    expect(s.received.some((l) => /DELETE/.test(l))).toBe(false)
  })
})

describe('when things go wrong', () => {
  it('gives up when the server does not answer', async () => {
    const s = server({ folders: [inbox], silent: true })
    const c = client(s, 'tls', 40)
    await expect(c.open().then(() => c.capability())).rejects.toMatchObject({ kind: 'timeout' })
  })

  it('reports a connection that drops in the middle of a command', async () => {
    const s = server({ folders: [inbox] })
    const c = client(s)
    await c.open()
    const pending = c.login('me@x.example', 'pw')
    s.hangUp()
    await expect(pending).rejects.toBeInstanceOf(ImapError)
    await expect(c.list()).rejects.toMatchObject({ kind: 'closed' })
  })

  it('runs commands one at a time, in the order given', async () => {
    const s = server({ folders: [inbox] })
    const c = client(s)
    await c.open()
    await c.login('me@x.example', 'pw')
    await Promise.all([c.list(), c.select('INBOX'), c.searchUids()])
    const verbs = s.received.filter((l) => /^A\d+ (LIST|EXAMINE|UID SEARCH)/.test(l)).map((l) => l.split(' ')[1])
    expect(verbs).toEqual(['LIST', 'EXAMINE', 'UID'])
  })

  it('logs out and closes', async () => {
    const s = server()
    const c = client(s)
    await c.open()
    await c.logout()
    expect(s.received.some((l) => /LOGOUT$/.test(l))).toBe(true)
    expect(s.closedByClient).toBe(true)
  })
})

describe('the parts', () => {
  it('writes a set of uids compactly', () => {
    expect(uidSet([5, 1, 2, 3, 9, 3])).toBe('1:3,5,9')
    expect(uidSet([])).toBe('')
    expect(uidSet([7])).toBe('7')
  })

  it('decodes folder names written in modified UTF-7', () => {
    expect(decodeMutf7('INBOX')).toBe('INBOX')
    expect(decodeMutf7('Entw&APw-rfe')).toBe('Entwürfe')
    expect(decodeMutf7('Tom &- Jerry')).toBe('Tom & Jerry')
    expect(decodeMutf7('&ZeVnLIqe-')).toBe('日本語')
  })

  it('cuts a stream into responses at line ends and literals, one byte at a time', () => {
    const r = new ResponseReader()
    const bytes = new TextEncoder().encode('* 1 FETCH (BODY[] {5}\r\nab\r\nc)\r\nA1 OK done\r\n')
    const seen: string[] = []
    for (const b of bytes) {
      r.push(Uint8Array.of(b))
      for (let x = r.next(); x; x = r.next()) seen.push(x.text.replace(/\u0000\d+\u0000/, '<lit>') + `|${x.literals.map((l) => new TextDecoder().decode(l)).join(',')}`)
    }
    expect(seen).toEqual(['* 1 FETCH (BODY[] <lit>)|ab\r\nc', 'A1 OK done|'])
  })

  it('reads lists, quoted strings with escapes, NIL and bracketed names', () => {
    const { node } = parseNode('(UID 4 FLAGS (\\Seen \\Flagged) X "a \\"quoted\\" b" Y NIL BODY[HEADER.FIELDS (FROM TO)] Z)', [])
    expect(node).toEqual(['UID', '4', 'FLAGS', ['\\Seen', '\\Flagged'], 'X', 'a "quoted" b', 'Y', null, 'BODY[HEADER.FIELDS (FROM TO)]', 'Z'])
  })
})
