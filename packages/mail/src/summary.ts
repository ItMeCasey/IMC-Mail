import PostalMime from 'postal-mime'
import type { Summary } from './imap'

/** What the server says about a message besides its headers. */
export interface SummaryBase {
  uid: number
  flags: string[]
  internalDate: string | null
  size: number
  /** The message's id on a server that has no stable numbers (POP3's UIDL). */
  remoteId?: string
}

/** Reads the headers of a message (as text) into the summary the lists show. */
export async function parseSummary(base: SummaryBase, header: string): Promise<Summary> {
  const mail = await PostalMime.parse(`${header.replace(/\r?\n$/, '')}\r\n\r\n`)
  const addr = (a: { name?: string; address?: string }) => ({ name: a.name ?? '', address: a.address ?? '' })
  const when = mail.date ? Date.parse(mail.date) : NaN
  return {
    ...base,
    from: mail.from?.address ? addr(mail.from) : null,
    to: (mail.to ?? []).filter((a) => a.address).map(addr),
    cc: (mail.cc ?? []).filter((a) => a.address).map(addr),
    subject: mail.subject ?? '',
    messageId: mail.messageId ?? null,
    inReplyTo: mail.inReplyTo ?? null,
    references: (mail.references ?? '').split(/\s+/).filter(Boolean),
    date: Number.isNaN(when) ? null : when
  }
}
