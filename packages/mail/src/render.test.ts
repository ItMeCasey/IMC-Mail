import { describe, expect, it } from 'vitest'
import { buildPhoneDocument, sanitizeEmailHtml, textToHtml } from './render'

const hostile = '<p onclick="steal()">Hi</p><script>alert(1)</script><img src="https://track.example/p.gif" onerror="x()"><a href="javascript:alert(1)">go</a><iframe src="https://evil.example"></iframe><style>@import url(https://evil.example/x.css);body{background:url(https://track.example/b.png)}</style>'

describe('the page the phone shows', () => {
  it('forbids scripts and remote loads in the page policy, and allows web images only on request', () => {
    const blocked = buildPhoneDocument('<p>x</p>', { allowImages: false, isText: false })
    const allowed = buildPhoneDocument('<p>x</p>', { allowImages: true, isText: false })
    expect(blocked).toContain("default-src 'none'")
    expect(blocked).toMatch(/img-src data:;/)
    expect(blocked).not.toMatch(/script-src|<script/)
    expect(allowed).toMatch(/img-src data: https: http:;/)
  })

  it('sanitized hostile mail leaves nothing that runs or loads, and says how many images it held back', () => {
    const r = sanitizeEmailHtml(hostile, { allowImages: false })
    const doc = buildPhoneDocument(r.html, { allowImages: false, isText: false })
    expect(doc).not.toMatch(/<script|onclick|onerror|javascript:|<iframe|@import|track\.example\/(p|b)/i)
    expect(doc).toContain('Hi')
    expect(r.blockedImages).toBeGreaterThanOrEqual(2)
  })

  it('does not show the message title as text', () => {
    const r = sanitizeEmailHtml('<html><head><title>SoFi</title></head><body><p>Hello</p></body></html>', { allowImages: true })
    expect(r.html).not.toContain('SoFi')
    expect(r.html).toContain('Hello')
  })

  it('lets web images through only when allowed', () => {
    expect(sanitizeEmailHtml('<img src="https://pics.example/a.png">', { allowImages: true }).html).toContain('https://pics.example/a.png')
    expect(sanitizeEmailHtml('<img src="https://pics.example/a.png">', { allowImages: false }).html).not.toContain('pics.example')
  })

  it('takes the destination off links of a message that looks like a scam', () => {
    const r = sanitizeEmailHtml('<a href="https://pay.example/login">Pay now</a>', { allowImages: false, defangLinks: true })
    expect(r.html).not.toContain('href')
    expect(r.html).toContain('data-defanged')
    expect(textToHtml('see https://pay.example/x now', { defangLinks: true })).not.toContain('href')
  })

  it('draws plain text in the app colors and keeps its line breaks', () => {
    const doc = buildPhoneDocument(textToHtml('a < b\nsecond line'), { allowImages: false, isText: true })
    expect(doc).toContain('white-space:pre-wrap')
    expect(doc).toContain('a &lt; b\nsecond line')
  })
})
