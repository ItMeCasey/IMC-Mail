import type { UndoMove, CalEvent, FolderRole, Invite, MessageAction, MessageDetail, Thread } from '@imc/core'
import { extractAttachment, makeSnippet, parseSource } from './parse-body'
import { buildDocument, sanitizeEmailHtml, textToHtml } from './render-email'
import type { BodyRow, MailStore, MessageRow } from './store'

/** What the service needs from the network layer; faked in tests. */
export interface RemoteMail {
  moveMessage(accountId: string, path: string, uid: number, dest: string): Promise<void>
  moveByMessageId?(accountId: string, path: string, rfcMessageId: string, dest: string): Promise<void>
  deleteMessage(accountId: string, path: string, uid: number): Promise<void>
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
    private remote: RemoteMail,
    private onMoved: (accountId: string) => void = () => {},
    private calendar?: {
      ingest(accountId: string, messageId: string, events: CalEvent[]): void
      inviteFor(messageId: string): Invite | null
    }
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
      if (parsed.events.length > 0) this.calendar?.ingest(m.accountId, id, parsed.events)
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
      blockedImages: 0,
      imagesAllowed: this.store.imagesAllowed(m.fromAddr),
      attachments: (body?.attachments ?? []).filter((a) => !a.inline),
      category: m.categoryManual ?? m.category ?? 'other',
      categoryManual: m.categoryManual !== null,
      risk: m.riskSafe
        ? { level: 'none', reasons: [] }
        : {
            level: m.risk ?? 'none',
            reasons: JSON.parse(m.riskReasons || '[]') as MessageDetail['risk']['reasons']
          },
      riskSafe: m.riskSafe,
      snoozedUntil: this.store.snoozedUntil(m.id),
      followUpAt: this.store.followUpAt(m.id),
      labelIds: this.store.labelIdsOf(m.id),
      invite: this.calendar?.inviteFor(m.id) ?? null
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

  /**
   * Archive, trash, junk, move, or erase one message. The server changes first; the cache only
   * follows when that worked, so a refusal leaves the message exactly where it was.
   */
  async act(id: string, action: MessageAction, folderId?: string): Promise<{ undo: UndoMove | null }> {
    const m = this.row(id)
    const rfcId = this.store.getReplyHeaders(id)?.messageId ?? null
    let undo: UndoMove | null = null
    const here = this.store.getFolder(m.folderId)
    const named = (role: FolderRole, what: string) => {
      const f = this.store.findFolderByRole(m.accountId, role)
      if (!f) throw new Error(`This account has no ${what} folder`)
      return f
    }

    if (action === 'deleteForever') {
      if (here?.role !== 'trash' && here?.role !== 'junk') {
        throw new Error('Only messages in Trash or Junk can be deleted for good')
      }
      await this.remote.deleteMessage(m.accountId, m.folderPath, m.uid)
    } else {
      let dest: { id: string; path: string }
      if (action === 'archive') {
        if (here?.role === 'archive' || here?.role === 'all') throw new Error('Already archived')
        dest = this.store.findFolderByRole(m.accountId, 'archive') ?? named('all', 'Archive')
      } else if (action === 'trash') {
        if (here?.role === 'trash') throw new Error('Already in Trash')
        dest = named('trash', 'Trash')
      } else if (action === 'junk') {
        if (here?.role === 'junk') throw new Error('Already in Junk')
        dest = named('junk', 'Junk')
      } else {
        const f = folderId ? this.store.getFolder(folderId) : undefined
        if (!f || f.accountId !== m.accountId) throw new Error('Choose a folder in the same account')
        if (f.id === m.folderId) throw new Error('The message is already in that folder')
        dest = f
      }
      await this.remote.moveMessage(m.accountId, m.folderPath, m.uid, dest.path)
      if (rfcId && this.remote.moveByMessageId) {
        const label = action === 'archive' ? 'Archived' : action === 'trash' ? 'Moved to Trash' : action === 'junk' ? 'Reported as junk' : `Moved to ${dest.path}`
        undo = { accountId: m.accountId, messageId: rfcId, from: dest.path, to: m.folderPath, label }
      }
    }
    this.store.removeMessage(id)
    this.store.rethread(m.accountId)
    this.onMoved(m.accountId)
    return { undo }
  }

  /** Moves a message back after an archive, trash, junk or move. The next sync brings it into the cache. */
  async undoMove(u: UndoMove): Promise<void> {
    if (!this.remote.moveByMessageId) throw new Error('Undo is not available')
    await this.remote.moveByMessageId(u.accountId, u.from, u.messageId, u.to)
    this.onMoved(u.accountId)
  }

  /** Hides a message until `until`; null brings it back now. */
  snooze(id: string, until: number | null, now = Date.now()): void {
    this.row(id)
    if (until === null) return this.store.unsnooze(id)
    if (until <= now + 30_000) throw new Error('Pick a time in the future')
    if (until - now > 366 * 24 * 3600 * 1000) throw new Error('Snooze for up to a year')
    this.store.snooze(id, until)
    this.onMoved(this.store.getMessage(id)!.accountId)
  }

  setLabels(id: string, labelIds: string[]): void {
    this.row(id)
    this.store.setLabels(id, labelIds)
  }

  /** Reminds you at `at` if nobody has replied to a message you sent; null clears the reminder. */
  followUp(id: string, at: number | null, now = Date.now()): void {
    this.row(id)
    if (at === null) return this.store.clearFollowUp(id)
    if (at <= now + 30_000) throw new Error('Pick a time in the future')
    if (at - now > 366 * 24 * 3600 * 1000) throw new Error('Set the reminder within a year')
    this.store.setFollowUp(id, at)
    this.onMoved(this.store.getMessage(id)!.accountId)
  }

  markSafe(id: string, safe: boolean): void {
    this.store.setRiskSafe(id, safe)
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
    o: { allowImages: boolean; allowLinks?: boolean; fg?: string; bg?: string }
  ): { html: string; csp: string } | null {
    const body = this.store.getBody(id)
    if (!body) return null
    const m = this.store.getMessage(id)
    // Links in a message the shield rates dangerous stay inert until you say otherwise.
    const defang = !o.allowLinks && !!m && !m.riskSafe && m.risk === 'danger'
    return body.html
      ? buildDocument(
          { html: sanitizeEmailHtml(body.html, { allowImages: o.allowImages, defangLinks: defang }).html, isText: false },
          { messageId: id, allowImages: o.allowImages }
        )
      : buildDocument(
          { html: textToHtml(body.text, { defangLinks: defang }), isText: true },
          { messageId: id, allowImages: false, fg: o.fg, bg: o.bg }
        )
  }
}
