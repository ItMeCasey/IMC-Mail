import { createHash } from 'node:crypto'

/**
 * Turns untrusted email HTML into markup that is safe to show.
 *
 * Defense in depth: this sanitizer strips scripts, handlers, embeds and remote loads, and the
 * document built by buildDocument() is served with a CSP that independently forbids scripts
 * (other than our own height reporter) and remote resources until the user allows images.
 */

export { sanitizeEmailHtml, scrubCss, textToHtml, type Rendered } from '@imc/mail/render'

const HEX = /^#[0-9a-f]{6}$/i

export interface DocumentOptions {
  messageId: string
  allowImages: boolean
  /** Only used for plain-text messages; HTML mail always renders on white like the sender intended. */
  fg?: string
  bg?: string
}

/** The script that reports content height to the parent; the only script the CSP allows. */
export function heightScript(messageId: string): string {
  const id = JSON.stringify(messageId).replace(/</g, '\\u003c')
  return `(function(){var id=${id};function s(){parent.postMessage({imcHeight:document.documentElement.scrollHeight+(document.documentElement.scrollWidth>document.documentElement.clientWidth?16:0),id:id},'*')}new ResizeObserver(s).observe(document.documentElement);addEventListener('load',s);s()})()`
}

export function buildDocument(
  body: { html: string; isText: boolean },
  o: DocumentOptions
): { html: string; csp: string } {
  const script = heightScript(o.messageId)
  const hash = createHash('sha256').update(script).digest('base64')
  const csp = [
    "default-src 'none'",
    `img-src data:${o.allowImages ? ' https: http:' : ''}`,
    "style-src 'unsafe-inline'",
    `script-src 'sha256-${hash}'`,
    "font-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ')

  const fg = o.fg && HEX.test(o.fg) ? o.fg : '#111111'
  const bg = o.bg && HEX.test(o.bg) ? o.bg : '#ffffff'
  const base = body.isText
    ? `html{background:${bg};color:${fg}}body{white-space:pre-wrap;font:13px/1.55 system-ui,'Segoe UI',sans-serif}a{color:inherit;text-decoration:underline}`
    : `html{background:#fff;color:#111}body{font:14px/1.5 system-ui,'Segoe UI',sans-serif}a{color:#1a47c7}`

  const html = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>*{box-sizing:border-box}html{overflow-x:auto;overflow-y:hidden}body{margin:0;padding:16px;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}a[data-defanged]{text-decoration:line-through;cursor:not-allowed}img[data-blocked]{display:inline-block;min-width:24px;min-height:24px;outline:1px dashed #8a8a8a}${base}</style></head><body>${body.html}<script>${script}</script></body></html>`
  return { html, csp }
}
