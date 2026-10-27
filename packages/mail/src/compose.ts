import type { Address } from './imap'

// Writing a message: turns what a person typed into the text an SMTP server takes (RFC 5322 with MIME), and works out
// the recipients, subject and quoted text for a reply or a forward.

export interface OutgoingAttachment {
  filename: string
  mimeType: string
  content: Uint8Array
}

export interface Outgoing {
  from: Address
  to: Address[]
  cc?: Address[]
  bcc?: Address[]
  subject: string
  /** The body as plain text. */
  text: string
  /** When given, the message goes as both text and HTML. */
  html?: string
  inReplyTo?: string | null
  references?: string[]
  attachments?: OutgoingAttachment[]
  /** Epoch ms for the Date header. */
  date?: number
  /** A Message-ID to use; otherwise one is made from the sender's domain. */
  messageId?: string
}

const enc = new TextEncoder()
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '=') + (i + 2 < bytes.length ? B64[n & 63]! : '=')
  }
  return out
}

/** Base64 in lines of 76 characters, as mail wants. */
const wrap64 = (bytes: Uint8Array): string => (base64(bytes).match(/.{1,76}/g) ?? []).join('\r\n')

const hex = (n: number) => n.toString(16).toUpperCase().padStart(2, '0')

/** Quoted-printable (RFC 2045): readable text stays readable, and lines are kept short. */
export function quotedPrintable(text: string): string {
  const bytes = enc.encode(text.replace(/\r\n|\r|\n/g, '\n'))
  let out = ''
  let line = ''
  const push = (piece: string) => {
    if (line.length + piece.length > 75) {
      out += `${line}=\r\n`
      line = ''
    }
    line += piece
  }
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!
    if (b === 10) {
      // A space or tab at the end of a line must be encoded, or it is lost.
      if (line.endsWith(' ')) line = `${line.slice(0, -1)}=20`
      else if (line.endsWith('\t')) line = `${line.slice(0, -1)}=09`
      out += `${line}\r\n`
      line = ''
    } else if ((b >= 33 && b <= 126 && b !== 61) || b === 32 || b === 9) push(String.fromCharCode(b))
    else push(`=${hex(b)}`)
  }
  if (line.endsWith(' ')) line = `${line.slice(0, -1)}=20`
  return out + line
}

/** A header value that may hold non-ASCII text, as an RFC 2047 encoded word when it must be. */
export function encodeHeaderText(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error('A header value contains a line break')
  if (/^[\x20-\x7e]*$/.test(value)) return value
  // Cut at character boundaries, and keep each word within 75 characters.
  const words: string[] = []
  let cur = ''
  for (const ch of value) {
    if (base64(enc.encode(cur + ch)).length > 44) {
      words.push(cur)
      cur = ''
    }
    cur += ch
  }
  if (cur) words.push(cur)
  return words.map((w) => `=?UTF-8?B?${base64(enc.encode(w))}?=`).join('\r\n ')
}

/** One address for a header: `Name <a@b>` with the name quoted or encoded as needed. */
export function formatAddress(a: Address): string {
  if (/[\r\n<>]/.test(a.address) || !/^[^\s@]+@[^\s@]+$/.test(a.address)) throw new Error(`"${a.address}" is not an email address`)
  const name = a.name.trim()
  if (!name || name === a.address) return a.address
  const shown = /^[\x20-\x7e]*$/.test(name) ? (/^[A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~]+$/.test(name) ? name : `"${name.replace(/(["\\])/g, '\\$1')}"`) : encodeHeaderText(name)
  return `${shown} <${a.address}>`
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The Date header, in UTC so it does not depend on the device's time zone. */
export function formatDate(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`
}

function randomId(): string {
  const bytes = new Uint8Array(12)
  globalThis.crypto.getRandomValues(bytes)
  return base64(bytes).replace(/[+/=]/g, 'x')
}

/** A Message-ID that is unique and carries the sender's domain. */
export const makeMessageId = (from: string): string => `<${randomId()}@${from.split('@')[1] ?? 'imc-mail.local'}>`

const boundary = () => `=_imc_${randomId()}`
const safeFilename = (n: string) => n.replace(/[\r\n"\\]/g, '_')

const textPart = (text: string): string => `Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${quotedPrintable(text)}`
const htmlPart = (html: string): string => `Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${quotedPrintable(html)}`

/** Folds a header line longer than 78 characters at spaces. */
function fold(line: string): string {
  if (line.length <= 78) return line
  const out: string[] = []
  let cur = ''
  for (const word of line.split(' ')) {
    if (cur && cur.length + word.length + 1 > 76) {
      out.push(cur)
      cur = ' ' + word
    } else cur = cur ? `${cur} ${word}` : word
  }
  out.push(cur)
  return out.join('\r\n')
}

/** The people the message goes to: To, Cc and Bcc, without repeats. */
export function recipientsOf(m: Pick<Outgoing, 'to' | 'cc' | 'bcc'>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const a of [...m.to, ...(m.cc ?? []), ...(m.bcc ?? [])]) {
    const k = a.address.toLowerCase()
    if (!seen.has(k)) {
      seen.add(k)
      out.push(a.address)
    }
  }
  return out
}

/** The message as bytes, ready to send or to save in a Sent folder. Bcc is left out of the headers. */
export function buildMessage(m: Outgoing): { raw: Uint8Array; messageId: string } {
  if (m.to.length + (m.cc?.length ?? 0) + (m.bcc?.length ?? 0) === 0) throw new Error('Add at least one recipient')
  const messageId = m.messageId ?? makeMessageId(m.from.address)
  if (/[\r\n]/.test(messageId)) throw new Error('A header value contains a line break')
  const lines: string[] = [
    `From: ${formatAddress(m.from)}`,
    ...(m.to.length ? [`To: ${m.to.map(formatAddress).join(', ')}`] : []),
    ...(m.cc?.length ? [`Cc: ${m.cc.map(formatAddress).join(', ')}`] : []),
    `Subject: ${encodeHeaderText(m.subject)}`,
    `Date: ${formatDate(m.date ?? Date.now())}`,
    `Message-ID: ${messageId}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo.replace(/[\r\n]/g, '')}`] : []),
    ...(m.references?.length ? [`References: ${m.references.map((r) => r.replace(/[\r\n\s]/g, '')).join(' ')}`] : []),
    'MIME-Version: 1.0',
    'X-Mailer: IMC-Mail'
  ]

  const attachments = m.attachments ?? []
  let body: string
  if (attachments.length === 0 && !m.html) {
    body = textPart(m.text)
  } else {
    const alt = m.html ? `multipart/alternative; boundary="${boundary()}"` : null
    const altBoundary = alt ? /boundary="([^"]+)"/.exec(alt)![1]! : ''
    const inner = alt ? `Content-Type: ${alt}\r\n\r\n--${altBoundary}\r\n${textPart(m.text)}\r\n--${altBoundary}\r\n${htmlPart(m.html!)}\r\n--${altBoundary}--` : textPart(m.text)
    if (attachments.length === 0) body = inner
    else {
      const mixed = boundary()
      const parts = attachments.map((a) => `--${mixed}\r\nContent-Type: ${a.mimeType.replace(/[\r\n]/g, '')}; name="${safeFilename(a.filename)}"\r\nContent-Disposition: attachment; filename="${safeFilename(a.filename)}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap64(a.content)}`)
      body = `Content-Type: multipart/mixed; boundary="${mixed}"\r\n\r\n--${mixed}\r\n${inner}\r\n${parts.join('\r\n')}\r\n--${mixed}--`
    }
  }
  const head = lines.map(fold).join('\r\n')
  return { raw: enc.encode(`${head}\r\n${body}\r\n`), messageId }
}

// ---- replies and forwards ----------------------------------------------------------------------------------------

export interface OriginalMessage {
  from: Address | null
  to: Address[]
  cc: Address[]
  subject: string
  messageId: string | null
  references: string[]
  /** Epoch ms, or null. */
  date: number | null
  text: string
}

export type ReplyMode = 'reply' | 'replyAll' | 'forward'

export interface Draft {
  to: Address[]
  cc: Address[]
  subject: string
  text: string
  inReplyTo: string | null
  references: string[]
}

const prefixed = (subject: string, prefix: 'Re' | 'Fwd'): string => {
  const base = subject.trim()
  const have = prefix === 'Re' ? /^re\s*:/i : /^(fwd?|fw)\s*:/i
  return have.test(base) ? base : `${prefix}: ${base}`.trim()
}

const quoted = (text: string): string =>
  text
    .replace(/\r\n|\r/g, '\n')
    .split('\n')
    .map((l) => (l ? `> ${l}` : '>'))
    .join('\n')

const who = (a: Address | null): string => (a ? (a.name ? `${a.name} <${a.address}>` : a.address) : 'someone')

/**
 * What to start a reply, reply-all or forward with. A reply goes to Reply-To's place, the sender (or, for a message you sent,
 * the people you sent it to); reply-all adds everyone else but you; the original text is quoted below, with its own header
 * for a forward.
 */
export function startDraft(original: OriginalMessage, mode: ReplyMode, me: string, replyTo?: Address | null): Draft {
  const mine = me.toLowerCase()
  const when = original.date !== null ? new Date(original.date).toUTCString() : 'an earlier date'
  if (mode === 'forward') {
    const head = [`---------- Forwarded message ----------`, `From: ${who(original.from)}`, `Date: ${when}`, `Subject: ${original.subject}`, ...(original.to.length ? [`To: ${original.to.map(who).join(', ')}`] : [])].join('\n')
    return { to: [], cc: [], subject: prefixed(original.subject, 'Fwd'), text: `\n\n${head}\n\n${original.text}`, inReplyTo: null, references: [] }
  }
  const sender = replyTo ?? original.from
  const sentByMe = original.from?.address.toLowerCase() === mine
  let to: Address[] = sentByMe ? original.to : sender ? [sender] : []
  let cc: Address[] = []
  if (mode === 'replyAll') {
    const seen = new Set(to.map((a) => a.address.toLowerCase()))
    cc = [...original.to, ...original.cc].filter((a) => {
      const k = a.address.toLowerCase()
      if (k === mine || seen.has(k)) return false
      seen.add(k)
      return true
    })
  }
  to = to.filter((a) => a.address.toLowerCase() !== mine || sentByMe)
  const refs = [...original.references, ...(original.messageId ? [original.messageId] : [])].slice(-20)
  return {
    to,
    cc,
    subject: prefixed(original.subject, 'Re'),
    text: `\n\nOn ${when}, ${who(original.from)} wrote:\n${quoted(original.text)}`,
    inReplyTo: original.messageId,
    references: refs
  }
}
