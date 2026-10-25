import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import MailComposer from 'nodemailer/lib/mail-composer'
import { createTransport } from 'nodemailer'
import addressparser from 'nodemailer/lib/addressparser'
import sanitizeHtml from 'sanitize-html'
import {
  draftSchema,
  type Contact,
  type Draft,
  type DraftAttachment,
  type DraftSummary,
  type OutboxItem,
  type ReplyContext,
  type ReplyMode
} from '@imc/core'
import type { Credential } from './credentials'
import { sanitizeEmailHtml, textToHtml } from './render-email'
import { isReplySubject } from './threading'
import type { AccountRow, BodyRow, MailStore } from './store'

export const UNDO_MS = 10_000
/** The furthest ahead a message can be scheduled. */
export const MAX_SCHEDULE_MS = 366 * 24 * 3600 * 1000
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

/** The network side of sending; faked or pointed at a local server in tests. */
export interface Mailer {
  send(
    account: AccountRow,
    raw: Buffer,
    envelope: { from: string; to: string[] }
  ): Promise<void>
  /** Copy to the Sent folder, for servers that do not file sent mail themselves. */
  appendToSent?(account: AccountRow, path: string, raw: Buffer): Promise<void>
}

export class SmtpMailer implements Mailer {
  constructor(
    private credentials: { get(account: AccountRow): Promise<Credential> },
    private appendRaw?: (accountId: string, path: string, raw: Buffer) => Promise<void>
  ) {}

  async send(
    account: AccountRow,
    raw: Buffer,
    envelope: { from: string; to: string[] }
  ): Promise<void> {
    const cred = await this.credentials.get(account)
    const { smtp, username } = account.config
    const transporter = createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.security === 'tls',
      // starttls must upgrade or fail, so credentials never cross in cleartext.
      requireTLS: smtp.security === 'starttls',
      ignoreTLS: smtp.security === 'none',
      auth:
        'accessToken' in cred
          ? { type: 'OAuth2', user: username, accessToken: cred.accessToken }
          : { user: username, pass: cred.pass },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 60_000
    })
    try {
      await transporter.sendMail({ envelope, raw })
    } finally {
      transporter.close()
    }
  }

  async appendToSent(account: AccountRow, path: string, raw: Buffer): Promise<void> {
    await this.appendRaw?.(account.id, path, raw)
  }
}

// ---- helpers ------------------------------------------------------------------

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/

/** "Name <a@b.co>" or "a@b.co" -> the bare address, or null if it is not an address. */
export function bareAddress(entry: string): string | null {
  const parsed = addressparser(entry)[0]
  const addr = parsed?.address?.trim()
  return addr && EMAIL.test(addr) ? addr : null
}

export function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>/gi, '\n\n')
  return sanitizeHtml(withBreaks, { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const withPrefix = (prefix: 'Re' | 'Fwd', subject: string): string => {
  const base = subject.replace(/^\s*((re|fwd?)\s*:\s*)+/i, '').trim()
  return `${prefix}: ${base}`
}

const dateFmt = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' })
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// ---- service ------------------------------------------------------------------

export class ComposeService {
  private timer: NodeJS.Timeout | null = null
  private busy = new Set<string>()

  constructor(
    private store: MailStore,
    private mailer: Mailer,
    private deps: {
      outboxDir: string
      ensureBody: (messageId: string) => Promise<BodyRow>
      onChange: () => void
      onSent: (accountId: string) => void
      /** A message sent with "remind me if nobody replies": its Message-ID and when to remind. */
      onFollowUp?: (accountId: string, messageId: string, due: number) => void
      undoMs?: number
      now?: () => number
    }
  ) {}

  private now = () => (this.deps.now ?? Date.now)()

  // -- attachments --

  async vetFiles(paths: string[]): Promise<DraftAttachment[]> {
    const out: DraftAttachment[] = []
    for (const p of paths) {
      const s = await stat(p)
      if (!s.isFile()) throw new Error(`${basename(p)} is not a file`)
      if (s.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(`${basename(p)} is larger than 25 MB, which most mail servers refuse`)
      }
      out.push({ id: randomUUID(), filename: basename(p), size: s.size, path: p })
    }
    return out
  }

  // -- drafts --

  saveDraft(draft: Draft): { id: string } {
    const id = draft.id ?? randomUUID()
    this.store.saveDraft(id, draft.accountId, JSON.stringify({ ...draft, id }))
    return { id }
  }

  listDrafts(): DraftSummary[] {
    return this.store.listDrafts().map((d) => {
      const p = JSON.parse(d.payload) as Draft
      return {
        id: d.id,
        accountId: d.accountId,
        subject: p.subject,
        to: p.to,
        updatedAt: d.updatedAt
      }
    })
  }

  loadDraft(id: string): Draft | null {
    const raw = this.store.getDraft(id)
    return raw ? draftSchema.parse(JSON.parse(raw)) : null
  }

  discardDraft(id: string): void {
    this.store.deleteDraft(id)
  }

  // -- replies --

  async replyContext(messageId: string, mode: ReplyMode): Promise<ReplyContext> {
    const m = this.store.getMessage(messageId)
    if (!m) throw new Error('That message is no longer in the cache')
    const body = await this.deps.ensureBody(messageId)
    const hdr = this.store.getReplyHeaders(messageId)
    const own = new Set(this.store.listAccounts().map((a) => a.email.toLowerCase()))
    const fromSelf = own.has(m.fromAddr.toLowerCase())

    const parse = (s: string): { name: string; address: string }[] =>
      addressparser(s).flatMap((a) =>
        a.address && EMAIL.test(a.address) ? [{ name: a.name, address: a.address }] : []
      )
    const fmt = (a: { name: string; address: string }) =>
      a.name ? `${a.name.replace(/["<>]/g, '')} <${a.address}>` : a.address

    const sender = { name: m.fromName, address: m.fromAddr }
    const origTo = parse(body.to || m.to)
    const origCc = parse(body.cc)

    let to: { name: string; address: string }[] = []
    let cc: { name: string; address: string }[] = []
    if (mode !== 'forward') {
      // Replying to something you sent goes to its recipients, not back to yourself.
      to = fromSelf ? origTo : [sender]
      if (mode === 'replyAll') {
        const taken = new Set(to.map((a) => a.address.toLowerCase()))
        const extra = [...origTo, ...origCc].filter(
          (a) => !own.has(a.address.toLowerCase()) && !taken.has(a.address.toLowerCase())
        )
        if (fromSelf) cc = origCc.filter((a) => !own.has(a.address.toLowerCase()))
        else cc = extra
      }
    }

    const quoted = body.html
      ? sanitizeEmailHtml(body.html, { allowImages: false }).html
      : textToHtml(body.text).replace(/\n/g, '<br>')
    const when = m.date ? dateFmt.format(new Date(m.date)) : ''
    const html =
      mode === 'forward'
        ? `<p></p><p>---------- Forwarded message ----------<br>From: ${esc(fmt(sender))}<br>Date: ${esc(when)}<br>Subject: ${esc(m.subject)}<br>To: ${esc(origTo.map(fmt).join(', '))}</p>${quoted}`
        : `<p></p><p>On ${esc(when)}, ${esc(fmt(sender))} wrote:</p><blockquote>${quoted}</blockquote>`

    return {
      accountId: m.accountId,
      to: to.map(fmt),
      cc: cc.map(fmt),
      subject: mode === 'forward' ? withPrefix('Fwd', m.subject) : isReplySubject(m.subject) ? m.subject : withPrefix('Re', m.subject),
      html,
      inReplyTo: mode === 'forward' ? undefined : (hdr?.messageId ?? undefined),
      references:
        mode === 'forward' ? [] : [...(hdr?.refs ?? []), ...(hdr?.messageId ? [hdr.messageId] : [])].slice(-20)
    }
  }

  // -- contacts --

  contacts(q: string): Contact[] {
    return q.trim().length < 2 ? [] : this.store.searchContacts(q.trim())
  }

  // -- sending --

  /** Validates and queues a message; it goes out when the undo window closes. */
  async send(
    draft: Draft,
    opts: { sendAt?: number; /** Skip the undo window (replies to invitations). */ immediate?: boolean } = {}
  ): Promise<{ outboxId: string; sendAt: number }> {
    const account = this.store.getAccount(draft.accountId)
    if (!account) throw new Error('Choose an account to send from')

    const clean = (list: string[], field: string) =>
      list.map((entry) => {
        const a = bareAddress(entry)
        if (!a) throw new Error(`"${entry}" in ${field} is not a valid email address`)
        return a
      })
    const to = clean(draft.to, 'To')
    const cc = clean(draft.cc, 'Cc')
    const bcc = clean(draft.bcc, 'Bcc')
    if (to.length + cc.length + bcc.length === 0) throw new Error('Add at least one recipient')

    const files = await this.vetFiles(draft.attachments.map((a) => a.path))
    const total = files.reduce((n, f) => n + f.size, 0)
    if (total > MAX_ATTACHMENT_BYTES) {
      throw new Error('Attachments total more than 25 MB, which most mail servers refuse')
    }

    // Copy attachments out of the user's folders so they survive until the send happens.
    const outboxId = randomUUID()
    const dir = join(this.deps.outboxDir, outboxId)
    await mkdir(dir, { recursive: true })
    const kept: DraftAttachment[] = []
    for (let i = 0; i < files.length; i++) {
      const f = files[i]!
      const dest = join(dir, `${i}-${f.filename}`)
      await copyFile(f.path, dest)
      // The recipient should see the file's real name, not the unique name used on disk.
      const shown = basename(draft.attachments[i]!.filename).replace(/[\u0000-\u001f]/g, '') || f.filename
      kept.push({ id: draft.attachments[i]!.id, filename: shown, size: f.size, path: dest })
    }

    const undoUntil = this.now() + (opts.immediate ? 0 : (this.deps.undoMs ?? UNDO_MS))
    if (opts.sendAt !== undefined && opts.sendAt - this.now() > MAX_SCHEDULE_MS) {
      throw new Error('Messages can be scheduled up to a year ahead')
    }
    // A time in the past, or inside the undo window, just means "send as usual".
    const sendAt = Math.max(undoUntil, opts.sendAt ?? 0)
    this.store.queueOutbox({
      id: outboxId,
      accountId: account.id,
      payload: JSON.stringify({ ...draft, attachments: kept }),
      sendAt,
      subject: draft.subject,
      to,
      createdAt: this.now()
    })
    if (draft.id) this.store.deleteDraft(draft.id)
    this.deps.onChange()
    return { outboxId, sendAt }
  }

  /** Cancels a queued or failed send and hands the draft back for editing. */
  undo(outboxId: string): Draft | null {
    const row = this.store.getOutbox(outboxId)
    if (!row || row.state === 'sending' || row.state === 'sent') return null
    this.store.deleteOutbox(outboxId)
    this.deps.onChange()
    return draftSchema.parse(JSON.parse(row.payload))
  }

  list(): OutboxItem[] {
    return this.store
      .listOutbox(this.now())
      .filter((r): r is NonNullable<typeof r> => !!r)
      .map((r) => ({
        id: r.id,
        accountId: r.accountId,
        subject: r.subject,
        to: r.to,
        state: r.state,
        error: r.error,
        sendAt: r.sendAt,
        createdAt: r.createdAt,
        scheduled: r.sendAt - r.createdAt > 3 * (this.deps.undoMs ?? UNDO_MS)
      }))
  }

  /** Builds the RFC 822 message for a queued draft. */
  async build(draft: Draft, account: AccountRow): Promise<{ raw: Buffer; messageId: string | null; envelope: { from: string; to: string[] } }> {
    const html = sanitizeEmailHtml(draft.html, { allowImages: false }).html
    const mail = new MailComposer({
      from: { name: account.displayName, address: account.email },
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      html,
      text: htmlToText(html),
      inReplyTo: draft.inReplyTo,
      references: draft.references?.join(' '),
      attachments: draft.attachments.map((a) => ({ filename: a.filename, path: a.path })),
      // A meeting invitation, reply or cancellation travels as a text/calendar alternative with its
      // METHOD, which is what Outlook and Exchange look for to show Accept / Decline buttons.
      ...(draft.ical
        ? {
            icalEvent: { method: draft.ical.method, content: draft.ical.content },
            headers: { 'Content-Class': 'urn:content-classes:calendarmessage' }
          }
        : {})
    })
    const compiled = mail.compile()
    const raw = await compiled.build()
    return {
      raw,
      messageId: compiled.messageId() || null,
      envelope: {
        from: account.email,
        to: [...draft.to, ...draft.cc, ...draft.bcc].flatMap((r) => bareAddress(r) ?? [])
      }
    }
  }

  private async process(id: string): Promise<void> {
    if (this.busy.has(id)) return
    this.busy.add(id)
    try {
      const row = this.store.getOutbox(id)
      if (!row || (row.state !== 'queued' && row.state !== 'sending')) return
      const account = this.store.getAccount(row.accountId)
      if (!account) {
        this.store.deleteOutbox(id)
        return
      }
      this.store.setOutboxState(id, 'sending')
      this.deps.onChange()
      try {
        const draft = draftSchema.parse(JSON.parse(row.payload))
        const { raw, messageId, envelope } = await this.build(draft, account)
        await this.mailer.send(account, raw, envelope)
        this.store.setOutboxState(id, 'sent')
        await rm(join(this.deps.outboxDir, id), { recursive: true, force: true })

        // Gmail and Microsoft file sent mail themselves; plain IMAP servers need a copy.
        const sentPath = this.store.sentFolderPath(account.id)
        if (account.provider === 'imap' && sentPath && this.mailer.appendToSent) {
          await this.mailer.appendToSent(account, sentPath, raw).catch((e) => {
            console.error('[compose] could not copy to Sent:', e instanceof Error ? e.message : e)
          })
        }
        if (draft.followUpDays && messageId) {
          this.deps.onFollowUp?.(account.id, messageId, this.now() + draft.followUpDays * 24 * 3600 * 1000)
        }
        this.deps.onSent(account.id)
      } catch (e) {
        this.store.setOutboxState(id, 'failed', e instanceof Error ? e.message : String(e))
      }
      this.deps.onChange()
    } finally {
      this.busy.delete(id)
    }
  }

  /** Sends everything whose undo window has closed. Exposed for tests; start() calls it. */
  async tick(): Promise<void> {
    for (const id of this.store.dueOutbox(this.now())) await this.process(id)
  }

  start(): void {
    if (this.timer) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), 1000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
