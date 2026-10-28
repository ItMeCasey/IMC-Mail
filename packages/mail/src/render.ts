import sanitizeHtml from 'sanitize-html'

/**
 * Turns untrusted email HTML into markup that is safe to show. Shared by the desktop and the phone.
 *
 * Defense in depth: this sanitizer strips scripts, handlers, embeds and remote loads. Wherever the result is shown
 * it must also sit in a document whose content security policy independently forbids scripts and (until the person
 * allows images) remote resources.
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
    nonTextTags: ['script', 'style', 'textarea', 'option', 'title'], // a message's <title> is not part of its body
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
            if (!opts.allowImages) {
              onBlocked()
              a['src'] = ''
              a['data-blocked'] = '1'
            } else if (src.startsWith('//')) {
              a['src'] = `https:${src}`
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

export interface PhoneDocumentOptions {
  /** Show images that load from the internet. They are off by default: they tell the sender the message was opened. */
  allowImages: boolean
  /** The body is plain text (made into HTML by `textToHtml`), so it is drawn in the app's own colors. */
  isText: boolean
}

/**
 * The page the phone's web view shows. The content security policy forbids everything but inline styles and images
 * (data images always; web images only when allowed), so even markup the sanitizer missed could not run or phone home.
 */
export function buildPhoneDocument(bodyHtml: string, o: PhoneDocumentOptions): string {
  const csp = ["default-src 'none'", `img-src data:${o.allowImages ? ' https: http:' : ''}`, "style-src 'unsafe-inline'", "base-uri 'none'", "form-action 'none'"].join('; ')
  const look = o.isText
    ? `html{background:#101418;color:#e4e8ee}body{white-space:pre-wrap;font:15px/1.5 sans-serif}a{color:#8ab4f8}`
    : `html{background:#fff;color:#111}body{font:15px/1.5 sans-serif}a{color:#1a47c7}`
  const style = `*{box-sizing:border-box}body{margin:0;padding:12px;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}a[data-defanged]{text-decoration:line-through}img[data-blocked]{display:inline-block;min-width:24px;min-height:24px;outline:1px dashed #8a8a8a}${look}`
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${style}</style></head><body>${bodyHtml}</body></html>`
}
