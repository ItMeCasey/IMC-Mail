import { describe, expect, it } from 'vitest'
import { extractAttachment, makeSnippet, parseSource } from './parse-body'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

const mime = [
  'From: Brand <deals@brand.example>',
  'To: me@x.example, "Pat" <pat@x.example>',
  'Cc: team@x.example',
  'Subject: Sponsorship brief',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="MIX"',
  '',
  '--MIX',
  'Content-Type: multipart/related; boundary="REL"',
  '',
  '--REL',
  'Content-Type: multipart/alternative; boundary="ALT"',
  '',
  '--ALT',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Hi =E2=80=94 the brief is attached.',
  '--ALT',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Hi <b>there</b></p><img src="cid:logo123">',
  '--ALT--',
  '--REL',
  'Content-Type: image/png',
  'Content-ID: <logo123>',
  'Content-Disposition: inline',
  'Content-Transfer-Encoding: base64',
  '',
  PNG.toString('base64'),
  '--REL--',
  '--MIX',
  'Content-Type: application/pdf; name="brief.pdf"',
  'Content-Disposition: attachment; filename="brief.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('%PDF-fake').toString('base64'),
  '--MIX--',
  ''
].join('\r\n')

describe('parseSource', () => {
  it('decodes text, recipients, embeds cid images, and lists real attachments', async () => {
    const p = await parseSource(Buffer.from(mime))
    expect(p.text).toContain('Hi — the brief is attached.')
    expect(p.to).toContain('pat@x.example')
    expect(p.cc).toBe('team@x.example')
    expect(p.html).toContain('data:image/png;base64,')
    expect(p.html).not.toContain('cid:')
    const real = p.attachments.filter((a) => !a.inline)
    expect(real).toHaveLength(1)
    expect(real[0]).toMatchObject({ filename: 'brief.pdf', mime: 'application/pdf' })
    expect(p.attachments.find((a) => a.inline)?.mime).toBe('image/png')
  })

  it('extracts an attachment by id', async () => {
    const p = await parseSource(Buffer.from(mime))
    const pdf = p.attachments.find((a) => a.filename === 'brief.pdf')!
    const got = await extractAttachment(Buffer.from(mime), pdf.id)
    expect(got?.filename).toBe('brief.pdf')
    expect(got?.content.toString()).toBe('%PDF-fake')
    expect(await extractAttachment(Buffer.from(mime), '99')).toBeNull()
  })

  it('handles a plain-text-only message', async () => {
    const p = await parseSource(Buffer.from('Subject: x\r\n\r\njust text\r\n'))
    expect(p.html).toBeNull()
    expect(p.text.trim()).toBe('just text')
  })
})

describe('makeSnippet', () => {
  it('prefers text, falls back to stripped html, and truncates', () => {
    expect(makeSnippet({ html: null, text: '  hello \n world ' })).toBe('hello world')
    expect(makeSnippet({ html: '<style>a{}</style><p>Hi&nbsp;<b>you</b></p>', text: '' })).toBe('Hi you')
    expect(makeSnippet({ html: null, text: 'x'.repeat(500) }, 10)).toHaveLength(10)
    expect(makeSnippet({ html: null, text: 'Hi there [https://t.example/p.gif?u=1]' })).toBe('Hi there')
  })
})
