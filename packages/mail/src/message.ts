import PostalMime from 'postal-mime'
import type { Address } from './imap'

export interface AttachmentInfo {
  filename: string
  mimeType: string
  size: number
  /** Part of the message body (an inline image), not something sent along. */
  inline: boolean
}

export interface ParsedMessage {
  subject: string
  from: Address | null
  to: Address[]
  cc: Address[]
  /** Epoch ms from the Date header, or null. */
  date: number | null
  messageId: string | null
  /** The message as plain text: its text part, or the HTML turned into text. Never HTML. */
  text: string
  /** The HTML part as the sender wrote it. Unsafe until sanitized; kept for rendering in a sandbox. */
  html: string | null
  attachments: AttachmentInfo[]
}

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·', euro: '€' }

const decodeEntities = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m
    }
    return entities[e.toLowerCase()] ?? m
  })

/**
 * Turns HTML into readable text: scripts, styles and comments go, block ends become line breaks, list items get a
 * bullet, and a link keeps its address when the visible words are something else. The result is plain text, so showing it
 * cannot run anything.
 */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, a?: string, b?: string, c?: string, inner = '') => {
      const href = decodeEntities(a ?? b ?? c ?? '').trim()
      const label = decodeEntities(inner.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
      if (!/^https?:\/\//i.test(href) || label === '' || label === href) return label || href
      return `${label} (${href})`
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<\/(p|div|tr|h[1-6]|li|ul|ol|table|blockquote|pre|section|article)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
  s = decodeEntities(s)
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const address = (a: { name?: string; address?: string }): Address => ({ name: a.name ?? '', address: a.address ?? '' })

/** Reads a whole message (as fetched from the server) into the pieces a screen needs. */
export async function parseMessage(raw: Uint8Array): Promise<ParsedMessage> {
  const mail = await PostalMime.parse(raw)
  const when = mail.date ? Date.parse(mail.date) : NaN
  const text = (mail.text ?? '').trim() !== '' ? mail.text!.replace(/\r\n/g, '\n').trim() : htmlToText(mail.html ?? '')
  return {
    subject: mail.subject ?? '',
    from: mail.from?.address ? address(mail.from) : null,
    to: (mail.to ?? []).filter((a) => a.address).map(address),
    cc: (mail.cc ?? []).filter((a) => a.address).map(address),
    date: Number.isNaN(when) ? null : when,
    messageId: mail.messageId ?? null,
    text,
    html: mail.html ?? null,
    attachments: (mail.attachments ?? []).map((a) => ({
      filename: a.filename ?? '(unnamed)',
      mimeType: a.mimeType ?? 'application/octet-stream',
      size: typeof a.content === 'string' ? a.content.length : (a.content?.byteLength ?? 0),
      inline: a.disposition === 'inline' || !!a.related
    }))
  }
}

export interface AttachmentContent {
  filename: string
  mimeType: string
  content: Uint8Array
}

/** The bytes of one attachment of a message (by its place in `parseMessage(...).attachments`), or null if there is no such one. */
export async function extractAttachment(raw: Uint8Array, index: number): Promise<AttachmentContent | null> {
  const mail = await PostalMime.parse(raw)
  const a = mail.attachments?.[index]
  if (!a) return null
  const content = typeof a.content === 'string' ? new TextEncoder().encode(a.content) : new Uint8Array(a.content)
  return { filename: a.filename ?? '(unnamed)', mimeType: a.mimeType ?? 'application/octet-stream', content }
}
