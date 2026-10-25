import { simpleParser, type AddressObject } from 'mailparser'
import type { Attachment } from '@imc/core'

export interface ParsedBody {
  html: string | null
  text: string
  to: string
  cc: string
  attachments: Attachment[]
}

/** Inline images larger than this stay as attachments instead of being embedded in the HTML. */
const MAX_INLINE_BYTES = 1_500_000

const addresses = (a: AddressObject | AddressObject[] | undefined): string =>
  (Array.isArray(a) ? a : a ? [a] : []).map((x) => x.text).join(', ')

/**
 * Parses a raw RFC 822 message. Inline `cid:` images are embedded as data URIs so the HTML is
 * self-contained, which lets the viewer stay offline and forbid every network load.
 */
export async function parseSource(source: Buffer): Promise<ParsedBody> {
  const mail = await simpleParser(source)
  let html = typeof mail.html === 'string' ? mail.html : null

  const attachments: Attachment[] = []
  mail.attachments.forEach((att, i) => {
    const inlineImage =
      att.cid && att.contentType.startsWith('image/') && att.size <= MAX_INLINE_BYTES
    if (html && inlineImage) {
      const cid = att.cid!.replace(/^<|>$/g, '')
      const uri = `data:${att.contentType};base64,${att.content.toString('base64')}`
      html = html.split(`cid:${cid}`).join(uri)
    }
    attachments.push({
      id: String(i),
      filename: att.filename || `attachment-${i + 1}`,
      mime: att.contentType || 'application/octet-stream',
      size: att.size,
      inline: Boolean(inlineImage && html)
    })
  })

  return {
    html,
    text: mail.text ?? '',
    to: addresses(mail.to),
    cc: addresses(mail.cc),
    attachments
  }
}

/** Re-parses a message and returns one attachment's bytes, by the id parseSource assigned. */
export async function extractAttachment(
  source: Buffer,
  id: string
): Promise<{ filename: string; content: Buffer } | null> {
  const mail = await simpleParser(source)
  const att = mail.attachments[Number(id)]
  return att ? { filename: att.filename || `attachment-${Number(id) + 1}`, content: att.content } : null
}

/** First useful words of a message, for collapsed thread entries. */
export function makeSnippet(body: Pick<ParsedBody, 'html' | 'text'>, max = 160): string {
  const base =
    body.text.trim() ||
    (body.html ?? '')
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
  // mailparser's text rendering of HTML mail appends "[url]" for images and links; drop those.
  return base
    .replace(/\[https?:\/\/[^\]\s]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}
