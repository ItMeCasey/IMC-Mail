import { describe, expect, it } from 'vitest'
import { dotStuff, SmtpClient, smtpAddress, SmtpError } from './smtp'
import { FakeSmtp, type FakeSmtpOptions } from './fake-smtp'

const server = (o: FakeSmtpOptions = {}) => new FakeSmtp({ user: 'me@x.example', password: 'pw', token: 'tok-1', ...o })
const client = (s: FakeSmtp, security: 'tls' | 'starttls' | 'none' = 'tls', timeoutMs = 2000) => new SmtpClient(s.connect, { host: 'smtp.test', port: 465, security, timeoutMs })
const bytes = (t: string) => new TextEncoder().encode(t)

describe('connecting and signing in', () => {
  it('reads the greeting and what the server offers', async () => {
    const s = server({ capabilities: ['SIZE 5000', 'AUTH PLAIN XOAUTH2'] })
    const c = client(s)
    await c.open()
    expect(s.tlsStarted).toBe(true)
    expect(c.capabilities.has('AUTH PLAIN XOAUTH2')).toBe(true)
    expect(c.maxSize).toBe(5000)
  })

  it('upgrades with STARTTLS and asks again afterwards, and refuses when it is not offered', async () => {
    const s = server({ capabilities: ['STARTTLS', 'AUTH PLAIN'] })
    await client(s, 'starttls').open()
    expect(s.tlsStarted).toBe(true)
    expect(s.lines.filter((l) => l.startsWith('EHLO')).length).toBe(2)
    await expect(client(server({ capabilities: ['AUTH PLAIN'] }), 'starttls').open()).rejects.toThrow(/does not offer STARTTLS/)
  })

  it('signs in with a password, with an OAuth token, and reports a refusal as a sign-in problem', async () => {
    const a = client(server())
    await a.open()
    await a.authPlain('me@x.example', 'pw')
    const b = client(server())
    await b.open()
    await b.authXoauth2('me@x.example', 'tok-1')
    const bad = client(server())
    await bad.open()
    await expect(bad.authPlain('me@x.example', 'nope')).rejects.toMatchObject({ kind: 'auth' })
    const expired = client(server())
    await expired.open()
    await expect(expired.authXoauth2('me@x.example', 'expired')).rejects.toMatchObject({ kind: 'auth' })
  })

  it('will not send a password over a connection that is not encrypted, or let sign-in details add a command', async () => {
    const plain = client(server(), 'none')
    await plain.open()
    await expect(plain.authPlain('me@x.example', 'pw')).rejects.toThrow(/not encrypted/)
    const c = client(server())
    await c.open()
    await expect(c.authPlain('me@x.example\r\nMAIL FROM:<x@y>', 'pw')).rejects.toThrow(/control character/)
    await expect(c.authXoauth2('me@x.example', 'a\r\nb')).rejects.toThrow(/control character/)
  })
})

describe('sending', () => {
  const ready = async (o: FakeSmtpOptions = {}) => {
    const s = server(o)
    const c = client(s)
    await c.open()
    await c.authPlain('me@x.example', 'pw')
    return { s, c }
  }

  it('hands over a message to everyone it goes to', async () => {
    const { s, c } = await ready()
    const raw = bytes('From: me@x.example\r\nSubject: Hi\r\n\r\nHello\r\n')
    await c.send('me@x.example', ['a@y.example', 'b@y.example'], raw)
    expect(s.messages).toEqual([{ from: 'me@x.example', to: ['a@y.example', 'b@y.example'], raw: 'From: me@x.example\r\nSubject: Hi\r\n\r\nHello\r\n' }])
  })

  it('keeps a line that starts with a dot from ending the message early', async () => {
    const { s, c } = await ready()
    const raw = bytes('Subject: Dots\r\n\r\n.hidden\r\n..two\r\n.\r\nstill here\r\n')
    await c.send('me@x.example', ['a@y.example'], raw)
    expect(s.messages[0]!.raw).toBe('Subject: Dots\r\n\r\n.hidden\r\n..two\r\n.\r\nstill here\r\n')
    expect(new TextDecoder().decode(dotStuff(bytes('.a\r\n.\r\nb')))).toBe('..a\r\n..\r\nb')
  })

  it('names the address the server refused', async () => {
    const { c } = await ready({ refuse: ['bad@y.example'] })
    await expect(c.send('me@x.example', ['ok@y.example', 'bad@y.example'], bytes('x'))).rejects.toMatchObject({ kind: 'recipient', message: expect.stringContaining('bad@y.example') })
  })

  it('refuses a message the server says is too big, and an empty recipient list', async () => {
    const { c } = await ready({ capabilities: ['SIZE 10', 'AUTH PLAIN'] })
    await expect(c.send('me@x.example', ['a@y.example'], bytes('x'.repeat(50)))).rejects.toThrow(/accepts/)
    await expect(c.send('me@x.example', [], bytes('x'))).rejects.toThrow(/nobody/)
  })

  it('reports a message the server did not accept', async () => {
    const { c } = await ready({ rejectData: '554 5.7.1 Spam' })
    await expect(c.send('me@x.example', ['a@y.example'], bytes('x'))).rejects.toMatchObject({ kind: 'rejected', message: expect.stringContaining('Spam') })
  })

  it('needs sign-in first', async () => {
    const s = server()
    const c = client(s)
    await c.open()
    await expect(c.send('me@x.example', ['a@y.example'], bytes('x'))).rejects.toThrow(/Authentication required/)
  })

  it('gives up when the server stops answering, and reports a dropped connection', async () => {
    const quiet = client(server({ silent: true }), 'tls', 40)
    await expect(quiet.open()).rejects.toMatchObject({ kind: 'timeout' })
    const s = server()
    const c = client(s)
    await c.open()
    s.hangUp()
    await expect(c.authPlain('me@x.example', 'pw')).rejects.toBeInstanceOf(SmtpError)
  })

  it('quits politely', async () => {
    const { s, c } = await ready()
    await c.quit()
    expect(s.lines.at(-1)).toBe('QUIT')
  })
})

describe('addresses', () => {
  it('accepts a plain address and refuses anything that could add a command', () => {
    expect(smtpAddress(' a@b.example ')).toBe('<a@b.example>')
    for (const bad of ['a@b.example>\r\nRCPT TO:<x@y', 'a b@c.example', '<a@b.example>', 'no-at-sign', 'a@b.example,c@d.example']) expect(() => smtpAddress(bad)).toThrow(SmtpError)
  })
})
