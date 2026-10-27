import { describe, expect, it } from 'vitest'
import { htmlToText, parseMessage } from './message'
import { ImapClient } from './imap'
import { FakeServer } from './fake-server'

const bytes = (s: string) => new TextEncoder().encode(s)
const crlf = (lines: string[]) => lines.join('\r\n')

describe('htmlToText', () => {
  it('turns blocks into lines, lists into bullets and drops scripts and styles', () => {
    const t = htmlToText('<html><head><style>p{color:red}</style><title>x</title></head><body><script>alert(1)</script><p>Hello <b>there</b></p><ul><li>One</li><li>Two</li></ul><div>Bye<br>now</div></body></html>')
    expect(t).toBe('Hello there\n• One\n• Two\n\nBye\nnow')
    expect(t).not.toMatch(/alert|color/)
  })

  it('keeps the address of a link whose words differ, and decodes entities', () => {
    expect(htmlToText('<a href="https://pay.example/x?a=1&amp;b=2">Click here</a> &amp; &lt;go&gt; &#8364;5 &#x41; &nbsp;done')).toBe('Click here (https://pay.example/x?a=1&b=2) & <go> €5 A done')
    expect(htmlToText('<a href="https://x.example">https://x.example</a>')).toBe('https://x.example')
    expect(htmlToText('<a href="javascript:alert(1)">Open</a>')).toBe('Open')
  })

  it('leaves no tags or script text, however the markup is written', () => {
    const t = htmlToText('<img src=x onerror=alert(1)><b onclick="x()">bold</b><scr<script>ipt>x</script>text<!-- <b>hidden</b> -->')
    expect(t).not.toMatch(/<script|<b|<img|onerror|onclick|hidden/i)
    expect(t).toContain('bold')
  })

  it('collapses runs of blank lines and spaces', () => {
    expect(htmlToText('<p>a</p><p></p><p></p><p>   b    c </p>')).toBe('a\n\nb c')
  })
})

describe('parseMessage', () => {
  it('reads a plain message with names, date and ids decoded', async () => {
    const m = await parseMessage(
      bytes(crlf(['From: =?utf-8?B?SsO8cmdlbg==?= <j@brand.example>', 'To: Me <me@x.example>, you@y.example', 'Cc: Boss <boss@x.example>', 'Subject: =?utf-8?Q?Caf=C3=A9_plans?=', 'Date: Tue, 3 Nov 2026 15:00:00 +0000', 'Message-ID: <abc@brand.example>', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', 'Caf=C3=A9 at noon.', '']))
    )
    expect(m).toMatchObject({ subject: 'Café plans', from: { name: 'Jürgen', address: 'j@brand.example' }, messageId: '<abc@brand.example>', date: Date.UTC(2026, 10, 3, 15) })
    expect(m.to.map((a) => a.address)).toEqual(['me@x.example', 'you@y.example'])
    expect(m.cc[0]).toEqual({ name: 'Boss', address: 'boss@x.example' })
    expect(m.text).toBe('Café at noon.')
    expect(m.attachments).toEqual([])
  })

  it('prefers the text part of a multipart/alternative, and keeps the HTML aside', async () => {
    const m = await parseMessage(
      bytes(
        crlf(['From: a@b.example', 'Subject: Alt', 'MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary="B"', '', '--B', 'Content-Type: text/plain; charset=utf-8', '', 'Plain version', '--B', 'Content-Type: text/html; charset=utf-8', '', '<p>HTML <b>version</b></p>', '--B--', ''])
      )
    )
    expect(m.text).toBe('Plain version')
    expect(m.html).toContain('<b>version</b>')
  })

  it('turns an HTML-only message into text', async () => {
    const m = await parseMessage(bytes(crlf(['From: a@b.example', 'Subject: H', 'Content-Type: text/html; charset=utf-8', '', '<h1>Title</h1><p>Body &amp; more</p><script>x()</script>', ''])))
    expect(m.text).toBe('Title\nBody & more')
    expect(m.text).not.toContain('x()')
  })

  it('lists attachments with their size, and reads base64 and other character sets', async () => {
    const m = await parseMessage(
      bytes(
        crlf([
          'From: a@b.example',
          'Subject: Files',
          'MIME-Version: 1.0',
          'Content-Type: multipart/mixed; boundary="M"',
          '',
          '--M',
          'Content-Type: text/plain; charset=iso-8859-1',
          'Content-Transfer-Encoding: 8bit',
          '',
          'Señor, see attached.',
          '--M',
          'Content-Type: application/pdf; name="rates.pdf"',
          'Content-Disposition: attachment; filename="rates.pdf"',
          'Content-Transfer-Encoding: base64',
          '',
          'SGVsbG8gd29ybGQ=',
          '--M--',
          ''
        ])
      )
    )
    expect(m.attachments).toEqual([{ filename: 'rates.pdf', mimeType: 'application/pdf', size: 11, inline: false }])
    expect(m.text).toContain('see attached')
  })

  it('copes with an empty or damaged message', async () => {
    expect(await parseMessage(bytes(''))).toMatchObject({ subject: '', text: '', from: null, attachments: [] })
    const odd = await parseMessage(bytes('Subject: x\r\nContent-Type: multipart/mixed; boundary="Z"\r\n\r\n--Z\r\nbroken'))
    expect(odd.subject).toBe('x')
  })
})

describe('fetching part of a message', () => {
  it('asks for only the first bytes when told to, and still gets a readable start', async () => {
    const raw = crlf(['From: a@b.example', 'Subject: Big', 'Content-Type: text/plain', '', 'x'.repeat(5000)])
    const s = new FakeServer({ user: 'u', password: 'p', folders: [{ path: 'INBOX', messages: [{ uid: 1, raw }] }] })
    const c = new ImapClient(s.connect, { host: 'h', port: 993, security: 'tls', timeoutMs: 2000 })
    await c.open()
    await c.login('u', 'p')
    await c.select('INBOX')
    const part = await c.fetchRaw(1, 300)
    expect(part.length).toBe(300)
    expect(s.received.some((l) => /BODY\.PEEK\[\]<0\.300>/.test(l))).toBe(true)
    expect((await parseMessage(part)).subject).toBe('Big')
    expect((await c.fetchRaw(1)).length).toBe(raw.length)
  })
})
