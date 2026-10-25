import { createHash } from 'node:crypto'
import sanitizeHtml from 'sanitize-html'

/**
 * Turns untrusted email HTML into markup that is safe to show.
 *
 * Defense in depth: this sanitizer strips scripts, handlers, embeds and remote loads, and the
 * document built by buildDocument() is served with a CSP that independently forbids scripts
 * (other than our own height reporter) and remote resources until the user allows images.
 */

export interface Rendered {
  html: string
  /** Remote images (and CSS url() loads) that were removed because images are not allowed. */
  blockedImages: number
}

const ALLOWED_TAGS = [
  'a', 'abbr', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'big', 'blockquote', 'br',
  'caption', 'center', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div',
  'dl', 'dt', 'em', 'figcaption', 'figure', 'font', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'main', 'mark', 'nav', 'ol', 'p', 'pre', 'q',
  's', 'samp', 'section', 'small', 'span', 'strike', 'strong', 'style', 'sub', 'summary', 'sup',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'tt', 'u', 'ul', 'var', 'wbr'
]

const GLOBAL_ATTRS = [
  'style', 'class', 'id', 'dir', 'lang', 'title', 'align', 'valign', 'bgcolor', 'width',
  'height', 'border', 'cellpadding', 'cellspacing', 'colspan', 'rowspan', 'color', 'face',
  'size', 'nowrap'
]

const SAFE_DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|bmp);/i
const REMOTE_URL = /^https?:\/\//i

/** Neutralises the CSS features that can run code, load remote content, or cover the page. */
export function scrubCss(css: string, allowImages: boolean, onBlocked: () => void): string {
  return css
    .replace(/@import\b[^;]*;?/gi, '')
    .replace(/expression\s*\(/gi, 'blocked(')
    .replace(/javascript\s*:/gi, 'blocked:')
    .replace(/-moz-binding\s*:/gi, 'blocked:')
    .replace(/behavior\s*:/gi, 'blocked:')
    .replace(/position\s*:\s*(fixed|sticky)/gi, 'position:static')
    .replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (_m, _q: string, u: string) => {
      const url = u.trim()
      if (SAFE_DATA_IMAGE.test(url)) return `url("${url}")`
      if (REMOTE_URL.test(url) && allowImages) return `url("${url}")`
      if (REMOTE_URL.test(url) || url.startsWith('//')) onBlocked()
      return 'url("")'
    })
}

export function sanitizeEmailHtml(
  raw: string,
  opts: { allowImages: boolean; /** Remove every link's destination (dangerous messages). */ defangLinks?: boolean }
): Rendered {
  let blocked = 0
  const onBlocked = () => void blocked++

  const out = sanitizeHtml(raw, {
    allowedTags: ALLOWED_TAGS,
    allowVulnerableTags: true, // <style> is needed for real-world email; the CSP and scrubCss contain it
    allowedAttributes: {
      '*': GLOBAL_ATTRS,
      a: ['href', 'name', 'target', 'rel', 'data-defanged'],
      img: ['src', 'alt', 'width', 'height', 'data-blocked']
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    transformTags: {
      '*': (tagName, attribs) => {
        const a = { ...attribs }
        if (a['style']) a['style'] = scrubCss(a['style'], opts.allowImages, onBlocked)
        if (tagName === 'a') {
          if (opts.defangLinks) {
            delete a['href']
            a['data-defanged'] = '1'
            a['title'] = 'Link disabled: this message looks like a scam'
          } else {
            a['target'] = '_blank'
            a['rel'] = 'noopener noreferrer'
          }
        }
        if (tagName === 'img') {
          const src = (a['src'] ?? '').trim()
          if (REMOTE_URL.test(src) || src.startsWith('//')) {
            if (!opts.allowImages || src.startsWith('//')) {
              onBlocked()
              a['src'] = ''
              a['data-blocked'] = '1'
            }
          } else if (src.startsWith('data:')) {
            if (!SAFE_DATA_IMAGE.test(src)) a['src'] = ''
          } else {
            a['src'] = '' // cid: that we could not resolve, or anything else
          }
        }
        return { tagName, attribs: a }
      }
    },
  })

  // sanitize-html re-serializes to normalized tags and passes <style> text through untouched,
  // so scrub the style blocks of its output rather than guessing at the raw input's structure.
  const scrubbed = out.replace(
    /(<style(?:\s[^>]*)?>)([\s\S]*?)(<\/style>)/gi,
    (_m, open: string, css: string, close: string) =>
      open + scrubCss(css, opts.allowImages, onBlocked) + close
  )

  return { html: scrubbed, blockedImages: blocked }
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Plain text to HTML: escaped, with http(s) and mailto links made clickable. */
export function textToHtml(text: string, opts: { defangLinks?: boolean } = {}): string {
  return escapeHtml(text).replace(
    /\b(https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?])/g,
    (u) =>
      opts.defangLinks
        ? `<a data-defanged="1" title="Link disabled: this message looks like a scam">${u}</a>`
        : `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`
  )
}

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
