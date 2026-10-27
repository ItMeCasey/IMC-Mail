import { describe, expect, it } from 'vitest'
import { buildMessage, encodeHeaderText, formatAddress, formatDate, quotedPrintable, recipientsOf, startDraft, type Outgoing, type OriginalMessage } from './compose'
import { parseMessage } from './message'

const me = { name: 'Casey Thompson', address: 'me@x.example' }
const a = { name: 'Alex Rivera', address: 'alex@y.example' }
const text = (raw: Uint8Array) => new TextDecoder().decode(raw)

const base = (over: Partial<Outgoing> = {}): Outgoing => ({ from: me, to: [a], subject: 'Hello', text: 'Plain body', date: Date.UTC(2026, 10, 3, 15, 4, 5), ...over })

describe('building a message', () => {
  it('reads back the way it was written, with names, subject and date intact', async () => {
    const { raw, messageId } = buildMessage(base({ subject: 'Café plans ☕', text: 'Señor, café at noon.\nSecond line', to: [{ name: 'Jürgen Müller', address: 'j@y.example' }, a], cc: [{ name: '', address: 'boss@x.example' }] }))
    const m = await parseMessage(raw)
    expect(m.subject).toBe('Café plans ☕')
    expect(m.from).toEqual({ name: 'Casey Thompson', address: 'me@x.example' })
    expect(m.to).toEqual([{ name: 'Jürgen Müller', address: 'j@y.example' }, { name: 'Alex Rivera', address: 'alex@y.example' }])
    expect(m.cc).toEqual([{ name: '', address: 'boss@x.example' }])
    expect(m.date).toBe(Date.UTC(2026, 10, 3, 15, 4, 5))
    expect(m.messageId).toBe(messageId)
    expect(m.text).toBe('Señor, café at noon.\nSecond line')
  })

  it('uses CRLF line ends, folds long headers, and never puts Bcc in the message', () => {
    const { raw } = buildMessage(base({ subject: 'word '.repeat(40), bcc: [{ name: '', address: 'secret@z.example' }] }))
    const t = text(raw)
    expect(t).not.toMatch(/[^\r]\n/)
    expect(t).not.toContain('secret@z.example')
    expect(t.split('\r\n').every((l) => l.length <= 78)).toBe(true)
    expect(recipientsOf(base({ bcc: [{ name: '', address: 'secret@z.example' }] }))).toEqual(['alex@y.example', 'secret@z.example'])
  })

  it('keeps a long line, trailing spaces and an equals sign in the text', async () => {
    const body = `${'long '.repeat(60)}\nends with space \nx = y`
    const m = await parseMessage(buildMessage(base({ text: body })).raw)
    expect(m.text).toBe(body.replace(/ \n/, ' \n'))
  })

  it('carries a reply thread in its headers', () => {
    const t = text(buildMessage(base({ inReplyTo: '<orig@y.example>', references: ['<a@y.example>', '<orig@y.example>'] })).raw)
    expect(t).toContain('In-Reply-To: <orig@y.example>')
    expect(t).toContain('References: <a@y.example> <orig@y.example>')
  })

  it('sends text and HTML together when asked', async () => {
    const m = await parseMessage(buildMessage(base({ text: 'plain', html: '<p>rich <b>text</b></p>' })).raw)
    expect(m.text).toBe('plain')
    expect(m.html).toContain('<b>text</b>')
  })

  it('attaches files, whatever their bytes', async () => {
    const bin = Uint8Array.from({ length: 5000 }, (_, i) => (i * 7) & 255)
    const m = await parseMessage(buildMessage(base({ attachments: [{ filename: 'rates "Q4".pdf', mimeType: 'application/pdf', content: bin }, { filename: 'note.txt', mimeType: 'text/plain', content: new TextEncoder().encode('hi') }] })).raw)
    expect(m.text).toBe('Plain body')
    expect(m.attachments.map((x) => [x.filename, x.mimeType, x.size])).toEqual([['rates _Q4_.pdf', 'application/pdf', 5000], ['note.txt', 'text/plain', 2]])
  })

  it('refuses anything that could add a header or smuggle a recipient', () => {
    expect(() => buildMessage(base({ subject: 'Hi\r\nBcc: spy@z.example' }))).toThrow(/line break/)
    expect(() => buildMessage(base({ to: [{ name: '', address: 'a@y.example\r\nBcc: spy@z.example' }] }))).toThrow(/not an email address/)
    expect(() => buildMessage(base({ inReplyTo: '<a@b>\r\nX: y' }))).not.toThrow()
    expect(text(buildMessage(base({ inReplyTo: '<a@b>\r\nX: y' })).raw)).not.toMatch(/\r\nX: y/)
    expect(() => buildMessage(base({ to: [] }))).toThrow(/at least one recipient/)
  })

  it('makes a message id from the sender domain, and a different one each time', () => {
    const one = buildMessage(base()).messageId
    expect(one).toMatch(/^<[A-Za-z0-9]+@x\.example>$/)
    expect(buildMessage(base()).messageId).not.toBe(one)
  })
})

describe('the parts', () => {
  it('encodes quoted-printable text', () => {
    expect(quotedPrintable('café = ok')).toBe('caf=C3=A9 =3D ok')
    expect(quotedPrintable('trailing \nspace')).toBe('trailing=20\r\nspace')
    expect(quotedPrintable('x'.repeat(200)).split('\r\n').every((l) => l.length <= 76)).toBe(true)
  })

  it('encodes non-ASCII header text in words that fit a line, and leaves ASCII alone', () => {
    expect(encodeHeaderText('Plain subject')).toBe('Plain subject')
    const words = encodeHeaderText('日本語'.repeat(20)).split('\r\n ')
    expect(words.length).toBeGreaterThan(1)
    expect(words.every((w) => w.length <= 75 && /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/.test(w))).toBe(true)
  })

  it('writes addresses with the name quoted when it needs it', () => {
    expect(formatAddress({ name: 'Alex Rivera', address: 'a@b.example' })).toBe('Alex Rivera <a@b.example>')
    expect(formatAddress({ name: 'Rivera, Alex', address: 'a@b.example' })).toBe('"Rivera, Alex" <a@b.example>')
    expect(formatAddress({ name: 'He said "hi"', address: 'a@b.example' })).toBe('"He said \\"hi\\"" <a@b.example>')
    expect(formatAddress({ name: '', address: 'a@b.example' })).toBe('a@b.example')
    expect(formatDate(Date.UTC(2026, 10, 3, 5, 4, 3))).toBe('Tue, 3 Nov 2026 05:04:03 +0000')
  })
})

describe('starting a reply or forward', () => {
  const original: OriginalMessage = {
    from: { name: 'Brand Team', address: 'team@brand.example' },
    to: [me, { name: '', address: 'colleague@x.example' }],
    cc: [{ name: '', address: 'boss@brand.example' }],
    subject: 'Sponsorship offer',
    messageId: '<orig@brand.example>',
    references: ['<earlier@brand.example>'],
    date: Date.UTC(2026, 10, 3, 15),
    text: 'We would like to work with you.\n\nThanks'
  }

  it('replies to the sender, quotes the message and keeps the thread', () => {
    const d = startDraft(original, 'reply', 'me@x.example')
    expect(d.to).toEqual([original.from])
    expect(d.cc).toEqual([])
    expect(d.subject).toBe('Re: Sponsorship offer')
    expect(d.inReplyTo).toBe('<orig@brand.example>')
    expect(d.references).toEqual(['<earlier@brand.example>', '<orig@brand.example>'])
    expect(d.text).toContain('Brand Team <team@brand.example> wrote:\n> We would like to work with you.\n>\n> Thanks')
  })

  it('replies to everyone but you, without repeats', () => {
    const d = startDraft({ ...original, cc: [...original.cc, { name: '', address: 'COLLEAGUE@x.example' }, { name: '', address: 'team@brand.example' }] }, 'replyAll', 'ME@x.example')
    expect(d.to.map((x) => x.address)).toEqual(['team@brand.example'])
    expect(d.cc.map((x) => x.address)).toEqual(['colleague@x.example', 'boss@brand.example'])
  })

  it('does not stack Re: and answers a message you sent to the people you sent it to', () => {
    expect(startDraft({ ...original, subject: 'RE: Sponsorship offer' }, 'reply', 'me@x.example').subject).toBe('RE: Sponsorship offer')
    const sent = startDraft({ ...original, from: me, to: [a] }, 'reply', 'me@x.example')
    expect(sent.to).toEqual([a])
  })

  it('prefers the Reply-To address', () => {
    expect(startDraft(original, 'reply', 'me@x.example', { name: 'Billing', address: 'billing@brand.example' }).to[0]!.address).toBe('billing@brand.example')
  })

  it('forwards with the original details and no thread', () => {
    const d = startDraft(original, 'forward', 'me@x.example')
    expect(d.subject).toBe('Fwd: Sponsorship offer')
    expect(d.to).toEqual([])
    expect(d.inReplyTo).toBeNull()
    expect(d.text).toContain('---------- Forwarded message ----------')
    expect(d.text).toContain('From: Brand Team <team@brand.example>')
    expect(d.text).toContain('We would like to work with you.')
    expect(startDraft({ ...original, subject: 'Fwd: Sponsorship offer' }, 'forward', 'me@x.example').subject).toBe('Fwd: Sponsorship offer')
  })

  it('keeps only the last 20 message ids in References', () => {
    const many = Array.from({ length: 30 }, (_, i) => `<m${i}@x>`)
    expect(startDraft({ ...original, references: many }, 'reply', 'me@x.example').references.length).toBe(20)
  })
})
