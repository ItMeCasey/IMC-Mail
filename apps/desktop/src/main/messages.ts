import type { MessageDetail, Thread } from '@imc/core'
import { extractAttachment, makeSnippet, parseSource } from './parse-body'
import { buildDocument, sanitizeEmailHtml, textToHtml } from './render-email'
import type { BodyRow, MailStore, MessageRow } from './store'

/** What the service needs from the network layer; faked in tests. */
export interface RemoteMail {
  fetchSource(
    accountId: string,
    path: string,
    uid: number,
    maxBytes: number
  ): Promise<{ source: Buffer; truncated: boolean }>
  setFlags(
    accountId: string,
    path: string,
    uid: number,
    change: { add?: string[]; remove?: string[] }
  ): Promise<void>
}

const BODY_LIMIT = 8 * 1024 * 1024
const ATTACHMENT_LIMIT = 100 * 1024 * 1024

/** Reads, caches, and renders message bodies, and applies flag changes. */
export class MessageService {
  private inflight = new Map<string, Promise<BodyRow>>()
  private errors = new Map<string, string>()

  constructor(
    private store: MailStore,
    private remote: RemoteMail
  ) {}

  private row(id: string): MessageRow {
    const r = this.store.getMessage(id)
    if (!r) throw new Error('That message is no longer in the cache')
    return r
  }

  /** Returns the cached body, downloading and parsing it first when needed. */
  ensureBody(id: string): Promise<BodyRow> {
    const cached = this.store.getBody(id)
    if (cached) return Promise.resolve(cached)
    let p = this.inflight.get(id)
    if (!p) {
      p = this.download(id).finally(() => this.inflight.delete(id))
      this.inflight.set(id, p)
    }
    return p
  }

  private async download(id: string): Promise<BodyRow> {
    const m = this.row(id)
    try {
      const { source, truncated } = await this.remote.fetchSource(
        m.accountId,
        m.folderPath,
        m.uid,
        BODY_LIMIT
      )
      const parsed = await parseSource(source)
      const body: BodyRow = { ...parsed, truncated }
      this.store.saveBody(id, body, makeSnippet(parsed))
      this.errors.delete(id)
      return body
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.errors.set(id, msg)
      throw e instanceof Error ? e : new Error(msg)
    }
  }

  private detail(m: MessageRow): MessageDetail {
    const body = this.store.getBody(m.id)
    const error = this.errors.get(m.id) ?? null
    return {
      id: m.id,
      accountId: m.accountId,
      folderId: m.folderId,
      uid: m.uid,
      fromName: m.fromName,
      fromAddr: m.fromAddr,
      to: body?.to || m.to,
      cc: body?.cc ?? '',
      subject: m.subject,
      date: m.date,
      unread: !m.flags.includes('\\Seen'),
      starred: m.flags.includes('\\Flagged'),
      bodyState: body ? 'ready' : error ? 'error' : 'missing',
      error: body ? null : error,
      snippet: m.snippet,
      blockedImages: body?.html
        ? sanitizeEmailHtml(body.html, { allowImages: false }).blockedImages
        : 0,
      imagesAllowed: this.store.imagesAllowed(m.fromAddr),
      attachments: (body?.attachments ?? []).filter((a) => !a.inline)
    }
  }

  async loadBody(id: string): Promise<MessageDetail> {
    try {
      await this.ensureBody(id)
    } catch {
      /* surfaced through detail().bodyState / error */
    }
    return this.detail(this.row(id))
  }

  /** The conversation around a message. Downloads the selected body and the newest one. */
  async open(id: string): Promise<Thread> {
    const messages = this.store.getThread(id)
    if (messages.length === 0) throw new Error('That message is no longer in the cache')
    const newest = messages[messages.length - 1]!
    await Promise.all([this.loadBody(id), id === newest.id ? null : this.loadBody(newest.id)])
    const fresh = this.store.getThread(id)
    const first = fresh.find((m) => m.subject.trim()) ?? fresh[0]!
    return {
      subject: first.subject,
      selectedId: id,
      messages: fresh.map((m) => this.detail(m))
    }
  }

  /** Optimistic: the cache changes at once and is rolled back if the server refuses. */
  async setFlags(id: string, change: { seen?: boolean; flagged?: boolean }): Promise<void> {
    const m = this.row(id)
    const before = m.flags
    this.store.setLocalFlags(id, change)
    const add: string[] = []
    const remove: string[] = []
    const mark = (flag: string, on: boolean | undefined) => {
      if (on === undefined) return
      ;(on ? add : remove).push(flag)
    }
    mark('\\Seen', change.seen)
    mark('\\Flagged', change.flagged)
    try {
      await this.remote.setFlags(m.accountId, m.folderPath, m.uid, { add, remove })
    } catch (e) {
      const prev = new Set(before.split(' ').filter(Boolean))
      this.store.setLocalFlags(id, {
        seen: prev.has('\\Seen'),
        flagged: prev.has('\\Flagged')
      })
      throw e
    }
  }

  allowImages(address: string): void {
    this.store.allowImagesFor(address)
  }

  async attachment(
    messageId: string,
    attachmentId: string
  ): Promise<{ filename: string; content: Buffer }> {
    const m = this.row(messageId)
    const { source } = await this.remote.fetchSource(
      m.accountId,
      m.folderPath,
      m.uid,
      ATTACHMENT_LIMIT
    )
    const att = await extractAttachment(source, attachmentId)
    if (!att) throw new Error('That attachment could not be found in the message')
    return att
  }

  /** The sandboxed HTML document and its CSP for one message, or null if the body is not cached. */
  render(
    id: string,
    o: { allowImages: boolean; fg?: string; bg?: string }
  ): { html: string; csp: string } | null {
    const body = this.store.getBody(id)
    if (!body) return null
    return body.html
      ? buildDocument(
          { html: sanitizeEmailHtml(body.html, { allowImages: o.allowImages }).html, isText: false },
          { messageId: id, allowImages: o.allowImages }
        )
      : buildDocument(
          { html: textToHtml(body.text), isText: true },
          { messageId: id, allowImages: false, fg: o.fg, bg: o.bg }
        )
  }
}
