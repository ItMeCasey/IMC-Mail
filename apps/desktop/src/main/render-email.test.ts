import { describe, expect, it } from 'vitest'
import {
  buildDocument,
  heightScript,
  sanitizeEmailHtml,
  scrubCss,
  textToHtml
} from './render-email'

const run = (html: string, allowImages = false) => sanitizeEmailHtml(html, { allowImages })

describe('active content', () => {
  it('removes scripts, handlers, embeds, forms and meta refresh', () => {
    const { html } = run(
      `<p onclick="x()">hi</p><script>alert(1)</script><iframe src="https://e.com"></iframe>` +
        `<object data="x"></object><embed src="x"><form action="https://e.com"><input name=p></form>` +
        `<meta http-equiv="refresh" content="0;url=https://e.com"><link rel="stylesheet" href="https://e.com/x.css">` +
        `<svg onload="x()"><script>1</script></svg><img src="x" onerror="x()">`
    )
    for (const bad of ['<script', 'onclick', 'onerror', 'onload', '<iframe', '<object', '<embed', '<form', '<input', '<meta', '<link', '<svg'])
      expect(html.toLowerCase(), bad).not.toContain(bad)
    expect(html).toContain('hi')
  })

  it('drops javascript: and data: hrefs but keeps http, https, mailto, tel', () => {
    const { html } = run(
      `<a href="javascript:alert(1)">a</a><a href="  JaVaScRiPt:x">b</a><a href="data:text/html,<script>1</script>">c</a>` +
        `<a href="https://ok.example/p">d</a><a href="mailto:a@b.co">e</a><a href="tel:+15551234">f</a>`
    )
    expect(html).not.toMatch(/javascript:/i)
    expect(html).not.toContain('data:text')
    expect(html).toContain('href="https://ok.example/p"')
    expect(html).toContain('href="mailto:a@b.co"')
    expect(html).toContain('href="tel:+15551234"')
  })

  it('forces links to open outside with noopener', () => {
    const { html } = run('<a href="https://a.example" target="_self">x</a>')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })
})

describe('remote images', () => {
  it('blocks and counts remote images by default, keeping alt and size', () => {
    const r = run(
      `<img src="https://t.example/p.gif?u=1" width="1" height="1" alt="px"><img src="http://t.example/b.png"><img src="//t.example/c.png">`
    )
    expect(r.blockedImages).toBe(3)
    expect(r.html).not.toContain('t.example')
    expect(r.html).toContain('data-blocked="1"')
    expect(r.html).toContain('alt="px"')
  })

  it('keeps https and http images once allowed, and loads protocol-relative ones over https', () => {
    const r = run(`<img src="https://a.example/x.png"><img src="//b.example/y.png">`, true)
    expect(r.html).toContain('https://a.example/x.png')
    expect(r.html).toContain('https://b.example/y.png')
  })

  it('keeps safe inline data images and drops other data and unresolved cid images', () => {
    const r = run(
      `<img src="data:image/png;base64,AAAA"><img src="data:text/html;base64,AAAA"><img src="cid:logo@x">`
    )
    expect(r.html).toContain('data:image/png;base64,AAAA')
    expect(r.html).not.toContain('text/html')
    expect(r.html).not.toContain('cid:')
    expect(r.blockedImages).toBe(0)
  })
})

describe('css', () => {
  it('blocks remote url() in style attributes and style blocks, and counts them', () => {
    const r = run(
      `<div style="background:url(https://t.example/bg.png)">x</div><style>.a{background:url('http://t.example/b.png')}</style>`
    )
    expect(r.html).not.toContain('t.example')
    expect(r.blockedImages).toBe(2)
  })

  it('removes @import, expression(), bindings and fixed positioning', () => {
    const css = scrubCss(
      `@import url(https://e.com/x.css); a{width:expression(alert(1));-moz-binding:url(x);position:fixed;behavior:url(x)}`,
      true,
      () => {}
    )
    expect(css).not.toMatch(/@import/i)
    expect(css).not.toMatch(/expression\s*\(/i)
    expect(css).not.toMatch(/-moz-binding\s*:/i)
    expect(css).not.toMatch(/position\s*:\s*fixed/i)
  })

  it('keeps safe data-image backgrounds', () => {
    const css = scrubCss('a{background:url("data:image/png;base64,AA")}', false, () => {})
    expect(css).toContain('data:image/png;base64,AA')
  })

  it('keeps ordinary layout markup intact', () => {
    const r = run(
      `<table width="600" cellpadding="0" style="margin:0 auto;color:#333"><tr><td align="center" bgcolor="#fff">Hello <b>there</b></td></tr></table>`
    )
    expect(r.html).toContain('<table')
    expect(r.html).toContain('align="center"')
    expect(r.html).toContain('<b>there</b>')
    expect(r.html).toContain('margin:0 auto')
  })
})

describe('textToHtml', () => {
  it('escapes markup and links bare urls without eating trailing punctuation', () => {
    const h = textToHtml('<b>x</b> see https://a.example/p?q=1, ok.')
    expect(h).toContain('&lt;b&gt;')
    expect(h).toContain('<a href="https://a.example/p?q=1"')
    expect(h).toContain('</a>, ok.')
  })
})

describe('buildDocument', () => {
  it('serves a CSP with no remote loads until images are allowed', () => {
    const blocked = buildDocument({ html: '<p>x</p>', isText: false }, { messageId: 'm1', allowImages: false })
    expect(blocked.csp).toContain("default-src 'none'")
    expect(blocked.csp).toMatch(/img-src data:(;|$)/)
    expect(blocked.csp).not.toContain("'unsafe-eval'")
    const allowed = buildDocument({ html: '<p>x</p>', isText: false }, { messageId: 'm1', allowImages: true })
    expect(allowed.csp).toContain('img-src data: https: http:')
  })

  it('allows only our own script by hash', () => {
    const d = buildDocument({ html: '', isText: false }, { messageId: 'm1', allowImages: false })
    expect(d.csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/)
    const scriptSrc = d.csp.split('; ').find((x) => x.startsWith('script-src'))!
    expect(scriptSrc).not.toMatch(/unsafe|\*|https?:/)
    expect((d.html.match(/<script>/g) ?? []).length).toBe(1)
  })

  it('cannot be broken out of through a hostile message id', () => {
    const s = heightScript('x</script><script>alert(1)//')
    expect(s).not.toContain('</script>')
  })

  it('ignores invalid theme colors for plain text', () => {
    const d = buildDocument({ html: 'hi', isText: true }, { messageId: 'm', allowImages: false, fg: 'red;}</style>', bg: '#112233' })
    expect(d.html).not.toContain('red;}')
    expect(d.html).toContain('#112233')
  })
})
