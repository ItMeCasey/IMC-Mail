import { randomUUID } from 'node:crypto'
import { buildSearch, parseQuery, SEARCH_LIMIT } from './search'
import {
  assess,
  type CalendarEvent,
  type RemoteEvent,
  type Label,
  type SavedSearch,
  type Rule,
  type RuleInput,
  type RuleTarget,
  type CalendarResponse,
  type Template,
  classify,
  type Category,
  type Deal,
  type DealPatch,
  type RiskLevel,
  type ViewCounts
} from '@imc/core'
import { computeThreads, normalizeSubject } from './threading'
import type {
  Account,
  Attachment,
  Folder,
  FolderRole,
  ImapAccountInput,
  MessageSummary,
  Provider,
  ServerConfig,
  SyncState
} from '@imc/core'
import type { Db } from './db'

const PALETTE = ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#06b6d4', '#8b5cf6', '#ef4444', '#84cc16']

/** Connection settings persisted per account (the password is NOT here, see SecretStore). */
export interface AccountConfig {
  /** Absent on accounts created before OAuth existed: treated as 'password'. */
  auth?: 'password' | 'oauth'
  username: string
  imap: ServerConfig
  smtp: ServerConfig
}

export interface AccountRow extends Account {
  config: AccountConfig
}

interface RawAccount {
  id: string
  provider: Provider
  email: string
  display_name: string
  color: string
  config: string
  last_error: string | null
  signature: string
}

export interface FetchedMessage {
  uid: number
  messageId: string | null
  fromName: string
  fromAddr: string
  to: string
  subject: string
  date: number
  flags: string[]
  /** In-Reply-To and References message ids, for threading. */
  refs: string[]
}

/** A meeting read from the account's own calendar. */
export type StoredRemoteEvent = Omit<RemoteEvent, 'remoteId'> & { id: string; accountId: string }

/** A meeting as stored: the public shape plus what only the app needs. */
export interface StoredEvent extends Omit<CalendarEvent, 'readOnly'> {
  exdates: number[]
  free: boolean
  updatedAt: number
}

export interface BodyRow {
  html: string | null
  text: string
  to: string
  cc: string
  attachments: Attachment[]
  truncated: boolean
  /** For the scam shield; absent on bodies cached before it existed. */
  replyTo?: string
  authResults?: string
  links?: { href: string; text: string }[]
}

export interface MessageRow {
  id: string
  accountId: string
  folderId: string
  folderPath: string
  uid: number
  threadId: string | null
  fromName: string
  fromAddr: string
  to: string
  subject: string
  date: number
  flags: string
  snippet: string
  category: Category | null
  categoryManual: Category | null
  risk: RiskLevel | null
  riskReasons: string
  riskSafe: boolean
}

/** The rules' verdict unless you overrode it. */
export const EFFECTIVE_CATEGORY = "COALESCE(m.category_manual, m.category, 'other')"
/** What the scam shield says, unless you marked the message safe. */
export const EFFECTIVE_RISK = "CASE WHEN m.risk_safe = 1 THEN 'none' ELSE COALESCE(m.risk, 'none') END"
const SUSPICIOUS = `(m.risk_safe = 0 AND m.risk IN ('caution', 'danger') AND f.role NOT IN ('trash', 'junk'))`
/** A message carrying the label @labelId (labels hang on the Message-ID). */
const LABELED = `EXISTS (SELECT 1 FROM message_label ml WHERE ml.account_id = m.account_id AND ml.rfc_id = m.message_id AND ml.label_id = @labelId)`
/** Excludes snoozed messages from a query over message m. */
const NOT_SNOOZED = 'NOT EXISTS (SELECT 1 FROM snooze sz WHERE sz.message_id = m.id)'
const REPLY_WINDOW_MS = 30 * 24 * 3600 * 1000
const WAIT_AFTER_MS = 3 * 24 * 3600 * 1000
const OWN = '(SELECT lower(email) FROM account)'
/** Later message in the same conversation (so this one is not the latest). */
const NO_LATER = `NOT EXISTS (SELECT 1 FROM message t WHERE t.thread_id IS NOT NULL AND t.thread_id = m.thread_id
     AND (t.date > m.date OR (t.date = m.date AND t.id > m.id)))`
/** Mail you owe a reply: the latest message in its conversation, from someone else. */
const NEEDS_REPLY = `(f.role = 'inbox' AND lower(m.from_addr) NOT IN ${OWN}
  AND lower(m.from_addr) NOT LIKE 'no-reply@%' AND lower(m.from_addr) NOT LIKE 'noreply@%'
  AND lower(m.from_addr) NOT LIKE 'donotreply@%' AND lower(m.from_addr) NOT LIKE 'do-not-reply@%'
  AND lower(m.from_addr) NOT LIKE 'mailer-daemon@%'
  AND instr(m.flags, '\\Answered') = 0
  AND ${EFFECTIVE_CATEGORY} NOT IN ('cold', 'platform')
  AND m.date >= @since AND ${NO_LATER})`
/** Something you sent, a few days ago, that nobody has answered. */
const WAITING = `(f.role = 'sent' AND lower(m.from_addr) IN ${OWN} AND m.to_addrs != ''
  AND m.date >= @since AND m.date <= @waitBefore AND ${NO_LATER})`

const SEEN = '\\Seen'
const FLAGGED = '\\Flagged'

/** The columns the scam shield fills in for one message. */
function riskColumns(input: Parameters<typeof assess>[0]): { risk: RiskLevel; riskReasons: string } {
  const r = assess(input)
  return { risk: r.level, riskReasons: JSON.stringify(r.reasons) }
}

/** All SQL for the mail cache lives here so the sync engine and IPC layer share one surface. */
export class MailStore {
  private states = new Map<string, SyncState>()

  constructor(private db: Db) {}

  // ---- accounts ----------------------------------------------------------

  setState(accountId: string, state: SyncState, error: string | null = null): void {
    this.states.set(accountId, state)
    this.db.prepare('UPDATE account SET last_error = ? WHERE id = ?').run(error, accountId)
  }

  listAccounts(): AccountRow[] {
    const rows = this.db
      .prepare('SELECT * FROM account ORDER BY created_at, email')
      .all() as RawAccount[]
    return rows.map((r) => this.toAccount(r))
  }

  getAccount(id: string): AccountRow | undefined {
    const r = this.db.prepare('SELECT * FROM account WHERE id = ?').get(id) as RawAccount | undefined
    return r && this.toAccount(r)
  }

  addAccount(
    input: Omit<ImapAccountInput, 'password'>,
    provider: Provider,
    auth: 'password' | 'oauth' = 'password'
  ): AccountRow {
    const id = randomUUID()
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM account').get() as { n: number }).n
    const config: AccountConfig = {
      auth,
      username: input.username,
      imap: input.imap,
      smtp: input.smtp
    }
    this.db
      .prepare(
        `INSERT INTO account (id, provider, email, display_name, color, auth_ref, config)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        provider,
        input.email,
        input.displayName ?? '',
        PALETTE[count % PALETTE.length],
        `account:${id}`,
        JSON.stringify(config)
      )
    return this.getAccount(id)!
  }

  removeAccount(id: string): void {
    this.states.delete(id)
    this.db.prepare('DELETE FROM account WHERE id = ?').run(id)
  }

  private toAccount(r: RawAccount): AccountRow {
    return {
      id: r.id,
      provider: r.provider,
      email: r.email,
      displayName: r.display_name,
      color: r.color,
      syncState: this.states.get(r.id) ?? 'connecting',
      lastError: r.last_error,
      signature: r.signature,
      config: JSON.parse(r.config) as AccountConfig
    }
  }

  // ---- folders -----------------------------------------------------------

  upsertFolder(
    accountId: string,
    f: { path: string; name: string; role: FolderRole | null }
  ): string {
    const id = `${accountId}:${f.path}`
    this.db
      .prepare(
        `INSERT INTO folder (id, account_id, path, name, role) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, role = excluded.role`
      )
      .run(id, accountId, f.path, f.name, f.role)
    return id
  }

  /** Whether other cached folders sit inside this one (their path starts with its path and a separator). */
  hasSubfolders(folderId: string): boolean {
    const f = this.getFolder(folderId)
    if (!f) return false
    return (
      this.db
        .prepare("SELECT 1 FROM folder WHERE account_id = ? AND id != ? AND substr(path, 1, length(?) + 1) IN (? || '/', ? || '.', ? || '\\')")
        .get(f.accountId, f.id, f.path, f.path, f.path, f.path) !== undefined
    )
  }

  /**
   * Forgets a folder and the ones inside it, with their cached messages. After a rename the next
   * sync brings them back under the new name (message ids contain the folder path, so they
   * cannot be renamed in place).
   */
  removeFolderTree(folderId: string): void {
    const f = this.getFolder(folderId)
    if (!f) return
    this.db
      .prepare("DELETE FROM folder WHERE account_id = ? AND (id = ? OR substr(path, 1, length(?) + 1) IN (? || '/', ? || '.', ? || '\\'))")
      .run(f.accountId, f.id, f.path, f.path, f.path, f.path)
  }

  /** Removes a folder and (by cascade) its cached messages. */
  removeFolder(folderId: string): void {
    this.db.prepare('DELETE FROM folder WHERE id = ?').run(folderId)
  }

  /** Drops folders that no longer exist on the server. */
  pruneFolders(accountId: string, keepPaths: string[]): void {
    const keep = new Set(keepPaths)
    const rows = this.db
      .prepare('SELECT id, path FROM folder WHERE account_id = ?')
      .all(accountId) as { id: string; path: string }[]
    const del = this.db.prepare('DELETE FROM folder WHERE id = ?')
    for (const r of rows) if (!keep.has(r.path)) del.run(r.id)
  }

  getFolderSyncState(folderId: string): { uidValidity: number | null } {
    const r = this.db.prepare('SELECT uidvalidity FROM folder WHERE id = ?').get(folderId) as
      | { uidvalidity: number | null }
      | undefined
    return { uidValidity: r?.uidvalidity ?? null }
  }

  setUidValidity(folderId: string, uidValidity: number): void {
    this.db.prepare('UPDATE folder SET uidvalidity = ? WHERE id = ?').run(uidValidity, folderId)
  }

  listFolders(): Folder[] {
    const rows = this.db
      .prepare(
        `SELECT f.id, f.account_id, f.path, f.name, f.role,
                COUNT(m.id) AS total,
                COALESCE(SUM(instr(m.flags, '${SEEN}') = 0), 0) AS unread
           FROM folder f
           JOIN account a ON a.id = f.account_id
           LEFT JOIN message m ON m.folder_id = f.id
                AND NOT EXISTS (SELECT 1 FROM snooze sz WHERE sz.message_id = m.id)
          GROUP BY f.id
          ORDER BY a.created_at, a.email,
                   CASE f.role WHEN 'inbox' THEN 0 WHEN 'drafts' THEN 1 WHEN 'sent' THEN 2
                               WHEN 'archive' THEN 3 WHEN 'junk' THEN 4 WHEN 'trash' THEN 5
                               ELSE 6 END,
                   f.name COLLATE NOCASE`
      )
      .all() as {
      id: string
      account_id: string
      path: string
      name: string
      role: FolderRole | null
      total: number
      unread: number
    }[]
    return rows.map((r) => ({
      id: r.id,
      accountId: r.account_id,
      path: r.path,
      name: r.name,
      role: r.role,
      unread: r.unread,
      total: r.total
    }))
  }

  /** Unread mail across all inboxes, not counting snoozed messages. */
  inboxUnread(): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM message m JOIN folder f ON f.id = m.folder_id
          WHERE f.role = 'inbox' AND instr(m.flags, '${SEEN}') = 0
            AND NOT EXISTS (SELECT 1 FROM snooze sz WHERE sz.message_id = m.id)`
      )
      .get() as { n: number }
    return r.n
  }

  // ---- messages ----------------------------------------------------------

  /** Wipes a folder's cached messages, used when UIDVALIDITY changes. */
  clearFolder(folderId: string): void {
    this.db.prepare('DELETE FROM message WHERE folder_id = ?').run(folderId)
  }

  /** The lowest UID of the newest `window` cached messages, or null if the folder is empty. */
  /** The lowest UID cached in a folder, or null if it is empty. */
  oldestUid(folderId: string): number | null {
    return (this.db.prepare('SELECT MIN(uid) AS uid FROM message WHERE folder_id = ?').get(folderId) as { uid: number | null }).uid
  }

  windowStartUid(folderId: string, window: number): number | null {
    const r = this.db
      .prepare(
        `SELECT MIN(uid) AS uid FROM
           (SELECT uid FROM message WHERE folder_id = ? ORDER BY uid DESC LIMIT ?)`
      )
      .get(folderId, window) as { uid: number | null }
    return r.uid
  }

  /**
   * Upserts fetched messages and, when `deleteMissingFrom` is set, removes cached messages
   * at or above that UID that the server no longer has.
   */
  applyFetched(
    accountId: string,
    folderId: string,
    fetched: FetchedMessage[],
    deleteMissingFrom: number | null
  ): string[] {
    const upsert = this.db.prepare(
      `INSERT INTO message
         (id, account_id, folder_id, uid, message_id, from_name, from_addr, to_addrs,
          subject, date, flags, refs, category, risk, risk_reasons)
       VALUES (@id, @accountId, @folderId, @uid, @messageId, @fromName, @fromAddr, @to,
               @subject, @date, @flags, @refs, @category, @risk, @riskReasons)
       ON CONFLICT(folder_id, uid) DO UPDATE SET flags = excluded.flags, refs = excluded.refs`
    )
    const known = this.db.prepare('SELECT 1 FROM message WHERE folder_id = ? AND uid = ?')
    const fresh: string[] = []
    this.db.transaction(() => {
      for (const m of fetched) {
        if (!known.get(folderId, m.uid)) fresh.push(`${folderId}:${m.uid}`)
        upsert.run({
          id: `${folderId}:${m.uid}`,
          accountId,
          folderId,
          uid: m.uid,
          messageId: m.messageId,
          fromName: m.fromName,
          fromAddr: m.fromAddr,
          to: m.to,
          subject: m.subject,
          date: m.date,
          flags: m.flags.join(' '),
          refs: m.refs.join(' '),
          category: classify({ fromAddr: m.fromAddr, fromName: m.fromName, subject: m.subject }).category,
          ...riskColumns({ fromAddr: m.fromAddr, fromName: m.fromName, subject: m.subject })
        })
      }
      if (deleteMissingFrom !== null) {
        const present = new Set(fetched.map((m) => m.uid))
        const cached = this.db
          .prepare('SELECT uid FROM message WHERE folder_id = ? AND uid >= ?')
          .all(folderId, deleteMissingFrom) as { uid: number }[]
        const del = this.db.prepare('DELETE FROM message WHERE folder_id = ? AND uid = ?')
        for (const { uid } of cached) if (!present.has(uid)) del.run(folderId, uid)
      }
    })()
    return fresh
  }

  listMessages(
    q: {
      accountId?: string
      folderId?: string
      limit: number
      offset: number
      view?: 'needsReply' | 'waiting' | 'suspicious' | 'snoozed' | 'followUp'
      category?: Category
      labelId?: string
    },
    now?: number
  ): MessageSummary[] {
    const where: string[] = []
    const args: Record<string, unknown> = { limit: q.limit, offset: q.offset }
    if (q.view !== 'snoozed') where.push(NOT_SNOOZED)
    if (q.labelId) {
      where.push(LABELED)
      args.labelId = q.labelId
    } else if (q.view === 'followUp') {
      where.push('EXISTS (SELECT 1 FROM followup fu WHERE fu.message_id = m.id)')
    } else if (q.view === 'snoozed') {
      where.push('EXISTS (SELECT 1 FROM snooze sz WHERE sz.message_id = m.id)')
    } else if (q.view) {
      where.push(q.view === 'needsReply' ? NEEDS_REPLY : q.view === 'waiting' ? WAITING : SUSPICIOUS)
      args.since = (now ?? Date.now()) - REPLY_WINDOW_MS
      args.waitBefore = (now ?? Date.now()) - WAIT_AFTER_MS
    } else if (q.folderId) {
      where.push('m.folder_id = @folderId')
      args.folderId = q.folderId
    } else {
      where.push("f.role = 'inbox'")
      if (q.accountId) {
        where.push('m.account_id = @accountId')
        args.accountId = q.accountId
      }
    }
    if (q.category) {
      where.push(`${EFFECTIVE_CATEGORY} = @category`)
      args.category = q.category
    }
    const rows = this.db
      .prepare(
        `SELECT m.id, m.account_id, m.folder_id, m.uid, m.from_name, m.from_addr,
                m.subject, m.date, m.flags, ${EFFECTIVE_CATEGORY} AS category, ${EFFECTIVE_RISK} AS risk,
                (SELECT until FROM snooze sz WHERE sz.message_id = m.id) AS snoozed_until,
                (SELECT due FROM followup fu WHERE fu.message_id = m.id) AS follow_up_at,
                EXISTS (SELECT 1 FROM event_message em WHERE em.message_id = m.id) AS has_invite,
                CASE WHEN m.thread_id IS NULL THEN 1
                     ELSE (SELECT COUNT(*) FROM message t WHERE t.thread_id = m.thread_id) END
                  AS thread_size
           FROM message m JOIN folder f ON f.id = m.folder_id
          WHERE ${where.join(' AND ')}
          ORDER BY ${q.view === 'snoozed' ? '(SELECT until FROM snooze sz WHERE sz.message_id = m.id) ASC' : q.view === 'followUp' ? '(SELECT due FROM followup fu WHERE fu.message_id = m.id) ASC' : 'm.date DESC, m.uid DESC'}
          LIMIT @limit OFFSET @offset`
      )
      .all(args) as {
      id: string
      account_id: string
      folder_id: string
      uid: number
      from_name: string
      from_addr: string
      subject: string
      date: number
      flags: string
      thread_size: number
      category: Category
      risk: RiskLevel
      snoozed_until: number | null
      follow_up_at: number | null
      has_invite: number
    }[]
    return rows.map((r) => ({
      id: r.id,
      accountId: r.account_id,
      folderId: r.folder_id,
      uid: r.uid,
      fromName: r.from_name,
      fromAddr: r.from_addr,
      subject: r.subject,
      date: r.date,
      unread: !r.flags.includes(SEEN),
      starred: r.flags.includes(FLAGGED),
      threadSize: r.thread_size,
      category: r.category,
      risk: r.risk,
      snoozedUntil: r.snoozed_until,
      followUpAt: r.follow_up_at,
      invite: r.has_invite === 1
    }))
  }

  /** Full-text and filtered search over the local cache. Never throws on odd input. */
  search(q: string, limit = SEARCH_LIMIT): MessageSummary[] {
    if (!q.trim()) return []
    const parsed = parseQuery(q)
    const hasAnything =
      parsed.fts !== null ||
      parsed.is.length > 0 ||
      parsed.hasAttachment ||
      parsed.account.length > 0 ||
      parsed.inFolder.length > 0 ||
      parsed.category.length > 0 ||
      parsed.label.length > 0 ||
      parsed.before !== null ||
      parsed.after !== null
    if (!hasAnything) return []
    const { sql, params } = buildSearch(parsed, limit)
    let rows: {
      id: string
      account_id: string
      folder_id: string
      uid: number
      from_name: string
      from_addr: string
      subject: string
      date: number
      flags: string
      thread_size: number
      category: Category
      risk: RiskLevel
      snoozed_until: number | null
      follow_up_at: number | null
      has_invite: number
    }[]
    try {
      rows = this.db.prepare(sql).all(params) as typeof rows
    } catch {
      return [] // a query FTS5 still refuses is "no results", not a crash
    }
    return rows.map((r) => ({
      id: r.id,
      accountId: r.account_id,
      folderId: r.folder_id,
      uid: r.uid,
      fromName: r.from_name,
      fromAddr: r.from_addr,
      subject: r.subject,
      date: r.date,
      unread: !r.flags.includes(SEEN),
      starred: r.flags.includes(FLAGGED),
      threadSize: r.thread_size,
      category: r.category,
      risk: r.risk,
      snoozedUntil: r.snoozed_until,
      followUpAt: r.follow_up_at,
      invite: r.has_invite === 1
    }))
  }

  // ---- single messages, bodies, threads ------------------------------------

  getMessage(id: string): MessageRow | undefined {
    const r = this.db
      .prepare(
        `SELECT m.id, m.account_id, m.folder_id, f.path AS folder_path, m.uid, m.thread_id,
                m.from_name, m.from_addr, m.to_addrs, m.subject, m.date, m.flags, m.snippet,
                m.category, m.category_manual, m.risk, m.risk_reasons, m.risk_safe
           FROM message m JOIN folder f ON f.id = m.folder_id WHERE m.id = ?`
      )
      .get(id) as
      | {
          id: string
          account_id: string
          folder_id: string
          folder_path: string
          uid: number
          thread_id: string | null
          from_name: string
          from_addr: string
          to_addrs: string
          subject: string
          date: number
          flags: string
          snippet: string
          category: Category | null
          category_manual: Category | null
          risk: RiskLevel | null
          risk_reasons: string
          risk_safe: number
        }
      | undefined
    return (
      r && {
        category: r.category,
        categoryManual: r.category_manual,
        risk: r.risk,
        riskReasons: r.risk_reasons,
        riskSafe: r.risk_safe === 1,
        id: r.id,
        accountId: r.account_id,
        folderId: r.folder_id,
        folderPath: r.folder_path,
        uid: r.uid,
        threadId: r.thread_id,
        fromName: r.from_name,
        fromAddr: r.from_addr,
        to: r.to_addrs,
        subject: r.subject,
        date: r.date,
        flags: r.flags,
        snippet: r.snippet
      }
    )
  }

  /** The account's folder for a role (e.g. 'trash'), if the server has one. */
  findFolderByRole(accountId: string, role: FolderRole): { id: string; path: string } | undefined {
    return this.db
      .prepare('SELECT id, path FROM folder WHERE account_id = ? AND role = ? LIMIT 1')
      .get(accountId, role) as { id: string; path: string } | undefined
  }

  getFolder(id: string): { id: string; accountId: string; path: string; role: FolderRole | null } | undefined {
    const r = this.db
      .prepare('SELECT id, account_id, path, role FROM folder WHERE id = ?')
      .get(id) as { id: string; account_id: string; path: string; role: FolderRole | null } | undefined
    return r && { id: r.id, accountId: r.account_id, path: r.path, role: r.role }
  }

  /** Drops a message from the cache (after it was moved or deleted on the server). */
  removeMessage(id: string): void {
    this.db.prepare('DELETE FROM message WHERE id = ?').run(id)
  }

  /** Threading headers of one message, for building a reply. */
  getReplyHeaders(id: string): { messageId: string | null; refs: string[]; toAddrs: string } | undefined {
    const r = this.db
      .prepare('SELECT message_id, refs, to_addrs FROM message WHERE id = ?')
      .get(id) as { message_id: string | null; refs: string; to_addrs: string } | undefined
    return (
      r && {
        messageId: r.message_id,
        refs: r.refs.split(' ').filter(Boolean),
        toAddrs: r.to_addrs
      }
    )
  }

  sentFolderPath(accountId: string): string | undefined {
    return (
      this.db
        .prepare("SELECT path FROM folder WHERE account_id = ? AND role = 'sent' LIMIT 1")
        .get(accountId) as { path: string } | undefined
    )?.path
  }

  /** Every message in the conversation (all folders of the account), oldest first. */
  getThread(id: string): MessageRow[] {
    const m = this.getMessage(id)
    if (!m) return []
    if (!m.threadId) return [m]
    const ids = this.db
      .prepare('SELECT id FROM message WHERE thread_id = ? ORDER BY date, id')
      .all(m.threadId) as { id: string }[]
    return ids.map((x) => this.getMessage(x.id)!)
  }

  getBody(id: string): BodyRow | undefined {
    const r = this.db.prepare('SELECT * FROM message_body WHERE message_id = ?').get(id) as
      | {
          html: string | null
          text: string
          to_text: string
          cc_text: string
          attachments: string
          truncated: number
          reply_to: string
          auth_results: string
          links: string
        }
      | undefined
    return (
      r && {
        replyTo: r.reply_to,
        authResults: r.auth_results,
        links: JSON.parse(r.links) as { href: string; text: string }[],
        html: r.html,
        text: r.text,
        to: r.to_text,
        cc: r.cc_text,
        attachments: JSON.parse(r.attachments) as Attachment[],
        truncated: r.truncated === 1
      }
    )
  }

  saveBody(id: string, body: BodyRow, snippet: string): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO message_body
             (message_id, html, text, to_text, cc_text, attachments, truncated, fetched_at,
              reply_to, auth_results, links)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          body.html,
          body.text,
          body.to,
          body.cc,
          JSON.stringify(body.attachments),
          body.truncated ? 1 : 0,
          Date.now(),
          body.replyTo ?? '',
          body.authResults ?? '',
          JSON.stringify(body.links ?? [])
        )
      this.db.prepare('UPDATE message SET snippet = ? WHERE id = ?').run(snippet, id)
      const m = this.getMessage(id)
      if (m) {
        const category = classify({
          fromAddr: m.fromAddr,
          fromName: m.fromName,
          subject: m.subject,
          text: body.text || snippet
        }).category
        this.db.prepare('UPDATE message SET category = ? WHERE id = ?').run(category, id)
        const cols = riskColumns({
          fromAddr: m.fromAddr,
          fromName: m.fromName,
          subject: m.subject,
          text: body.text || snippet,
          replyTo: body.replyTo,
          authResults: body.authResults,
          links: body.links,
          attachments: body.attachments.filter((a) => !a.inline)
        })
        this.db
          .prepare('UPDATE message SET risk = ?, risk_reasons = ? WHERE id = ?')
          .run(cols.risk, cols.riskReasons, id)
      }
    })()
  }

  /** Updates the cached flag list after a local change, keeping everything else as is. */
  setLocalFlags(id: string, update: { seen?: boolean; flagged?: boolean }): string | null {
    const m = this.getMessage(id)
    if (!m) return null
    const flags = new Set(m.flags.split(' ').filter(Boolean))
    const apply = (flag: string, on: boolean | undefined) => {
      if (on === undefined) return
      if (on) flags.add(flag)
      else flags.delete(flag)
    }
    apply(SEEN, update.seen)
    apply(FLAGGED, update.flagged)
    const next = [...flags].join(' ')
    this.db.prepare('UPDATE message SET flags = ? WHERE id = ?').run(next, id)
    return next
  }

  /** Sets or clears the read flag on every cached message in a folder. Returns how many changed. */
  setSeenInFolder(folderId: string, seen: boolean): number {
    const rows = this.db.prepare('SELECT id, flags FROM message WHERE folder_id = ?').all(folderId) as { id: string; flags: string }[]
    const update = this.db.prepare('UPDATE message SET flags = ? WHERE id = ?')
    let changed = 0
    this.db.transaction(() => {
      for (const r of rows) {
        const flags = new Set(r.flags.split(' ').filter(Boolean))
        if (flags.has(SEEN) === seen) continue
        if (seen) flags.add(SEEN)
        else flags.delete(SEEN)
        update.run([...flags].join(' '), r.id)
        changed++
      }
    })()
    return changed
  }

  allowImagesFor(address: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO image_allow (address) VALUES (?)')
      .run(address.trim().toLowerCase())
  }

  imagesAllowed(address: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM image_allow WHERE address = ?')
      .get(address.trim().toLowerCase())
  }

  // ---- categories, smart views, deals --------------------------------------------

  /** null puts the message back under the rules' control. */
  setCategory(id: string, category: Category | null): void {
    this.db.prepare('UPDATE message SET category_manual = ? WHERE id = ?').run(category, id)
  }

  /** Inbox messages by id, shaped for the notification rules. */
  incoming(ids: string[]): {
    id: string
    fromName: string
    fromAddr: string
    subject: string
    category: Category
    risk: RiskLevel
    date: number
    unread: boolean
  }[] {
    const get = this.db.prepare(
      `SELECT m.id, m.from_name, m.from_addr, m.subject, m.date, m.flags,
              ${EFFECTIVE_CATEGORY} AS category, ${EFFECTIVE_RISK} AS risk
         FROM message m JOIN folder f ON f.id = m.folder_id
        WHERE m.id = ? AND f.role = 'inbox'`
    )
    const out = []
    for (const id of ids) {
      const r = get.get(id) as
        | { id: string; from_name: string; from_addr: string; subject: string; date: number; flags: string; category: Category; risk: RiskLevel }
        | undefined
      if (r) {
        out.push({
          id: r.id,
          fromName: r.from_name,
          fromAddr: r.from_addr,
          subject: r.subject,
          category: r.category,
          risk: r.risk,
          date: r.date,
          unread: !r.flags.includes(SEEN)
        })
      }
    }
    return out
  }

  snooze(id: string, until: number): void {
    this.db
      .prepare('INSERT INTO snooze (message_id, until) VALUES (?, ?) ON CONFLICT(message_id) DO UPDATE SET until = excluded.until')
      .run(id, until)
  }

  unsnooze(id: string): void {
    this.db.prepare('DELETE FROM snooze WHERE message_id = ?').run(id)
  }

  snoozedUntil(id: string): number | null {
    return (
      (this.db.prepare('SELECT until FROM snooze WHERE message_id = ?').get(id) as { until: number } | undefined)
        ?.until ?? null
    )
  }

  /** Snoozes whose time has come: removes them and returns the message ids. */
  wakeDue(now: number): string[] {
    const ids = (
      this.db.prepare('SELECT message_id FROM snooze WHERE until <= ? ORDER BY until').all(now) as {
        message_id: string
      }[]
    ).map((r) => r.message_id)
    if (ids.length > 0) {
      const del = this.db.prepare('DELETE FROM snooze WHERE message_id = ?')
      this.db.transaction(() => ids.forEach((id) => del.run(id)))()
    }
    return ids
  }

  // ---- saved searches --------------------------------------------------------------

  listSavedSearches(): SavedSearch[] {
    return this.db.prepare('SELECT id, name, query FROM saved_search ORDER BY created_at, rowid').all() as SavedSearch[]
  }

  saveSearch(name: string, query: string, now = Date.now()): SavedSearch {
    const clean = { name: name.trim(), query: query.trim() }
    // Saving the same search again just renames it.
    const same = this.db.prepare('SELECT id FROM saved_search WHERE query = ?').get(clean.query) as { id: string } | undefined
    const id = same?.id ?? randomUUID()
    if (same) this.db.prepare('UPDATE saved_search SET name = ? WHERE id = ?').run(clean.name, id)
    else this.db.prepare('INSERT INTO saved_search (id, name, query, created_at) VALUES (?, ?, ?, ?)').run(id, clean.name, clean.query, now)
    return { id, ...clean }
  }

  /** Creates or updates the saved search with this id. */
  putSavedSearch(id: string, name: string, query: string, now = Date.now()): void {
    this.db
      .prepare(
        'INSERT INTO saved_search (id, name, query, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, query = excluded.query'
      )
      .run(id, name.trim(), query.trim(), now)
  }

  deleteSavedSearch(id: string): void {
    this.db.prepare('DELETE FROM saved_search WHERE id = ?').run(id)
  }

  // ---- rules ----------------------------------------------------------------------

  listRules(): Rule[] {
    return (
      this.db.prepare('SELECT id, name, enabled, match, actions FROM rule ORDER BY created_at, rowid').all() as {
        id: string
        name: string
        enabled: number
        match: string
        actions: string
      }[]
    ).map((r) => ({ id: r.id, name: r.name, enabled: r.enabled === 1, match: JSON.parse(r.match), actions: JSON.parse(r.actions) }))
  }

  saveRule(input: Omit<Rule, 'id'> & { id?: string }, now = Date.now()): Rule {
    const id = input.id ?? randomUUID()
    const exists = input.id ? this.db.prepare('SELECT 1 FROM rule WHERE id = ?').get(input.id) : undefined
    const cols = [input.name.trim(), input.enabled ? 1 : 0, JSON.stringify(input.match), JSON.stringify(input.actions)] as const
    if (exists) this.db.prepare('UPDATE rule SET name = ?, enabled = ?, match = ?, actions = ? WHERE id = ?').run(...cols, id)
    else this.db.prepare('INSERT INTO rule (name, enabled, match, actions, id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(...cols, id, now)
    return { ...input, id, name: input.name.trim() } as Rule
  }

  deleteRule(id: string): void {
    this.db.prepare('DELETE FROM rule WHERE id = ?').run(id)
  }

  /** What a rule looks at, for messages that are in an inbox. */
  ruleTargets(ids: string[]): { id: string; target: RuleTarget }[] {
    const get = this.db.prepare(
      `SELECT m.id, m.from_name, m.from_addr, m.to_addrs, m.subject, m.snippet
         FROM message m JOIN folder f ON f.id = m.folder_id WHERE m.id = ? AND f.role = 'inbox'`
    )
    const out: { id: string; target: RuleTarget }[] = []
    for (const id of ids) {
      const r = get.get(id) as { id: string; from_name: string; from_addr: string; to_addrs: string; subject: string; snippet: string } | undefined
      if (r) out.push({ id: r.id, target: { fromName: r.from_name, fromAddr: r.from_addr, to: r.to_addrs, subject: r.subject, snippet: r.snippet } })
    }
    return out
  }

  /** The newest inbox messages, for running a rule over existing mail. */
  recentInboxIds(limit: number): string[] {
    return (
      this.db
        .prepare("SELECT m.id FROM message m JOIN folder f ON f.id = m.folder_id WHERE f.role = 'inbox' ORDER BY m.date DESC LIMIT ?")
        .all(limit) as { id: string }[]
    ).map((r) => r.id)
  }

  // ---- labels ------------------------------------------------------------------------

  listLabels(): Label[] {
    return this.db
      .prepare(
        `SELECT l.id, l.name,
                (SELECT COUNT(*) FROM message m JOIN message_label ml
                   ON ml.account_id = m.account_id AND ml.rfc_id = m.message_id
                  WHERE ml.label_id = l.id) AS count
           FROM label l ORDER BY l.name COLLATE NOCASE`
      )
      .all() as Label[]
  }

  createLabel(name: string): Label {
    const clean = name.trim()
    const existing = this.db.prepare('SELECT id, name FROM label WHERE name = ?').get(clean) as { id: string; name: string } | undefined
    if (existing) return { ...existing, count: 0 }
    const id = randomUUID()
    this.db.prepare('INSERT INTO label (id, name) VALUES (?, ?)').run(id, clean)
    return { id, name: clean, count: 0 }
  }

  /** Creates the label with this id, or renames it. False if another label already has the name. */
  putLabel(id: string, name: string): boolean {
    const clean = name.trim()
    const clash = this.db.prepare('SELECT id FROM label WHERE name = ? AND id != ?').get(clean, id)
    if (clash) return false
    this.db.prepare('INSERT INTO label (id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name').run(id, clean)
    return true
  }

  deleteLabel(id: string): void {
    this.db.prepare('DELETE FROM label WHERE id = ?').run(id)
  }

  labelIdsOf(messageDbId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT ml.label_id FROM message m JOIN message_label ml
              ON ml.account_id = m.account_id AND ml.rfc_id = m.message_id
            WHERE m.id = ?`
        )
        .all(messageDbId) as { label_id: string }[]
    ).map((r) => r.label_id)
  }

  /** Replaces a message's labels. A message with no Message-ID header cannot be labelled. */
  setLabels(messageDbId: string, labelIds: string[]): void {
    const m = this.db.prepare('SELECT account_id, message_id FROM message WHERE id = ?').get(messageDbId) as
      | { account_id: string; message_id: string | null }
      | undefined
    if (!m) throw new Error('That message is no longer in the cache')
    if (!m.message_id) throw new Error('This message has no Message-ID, so it cannot be labelled')
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM message_label WHERE account_id = ? AND rfc_id = ?').run(m.account_id, m.message_id)
      const ins = this.db.prepare('INSERT OR IGNORE INTO message_label (account_id, rfc_id, label_id) SELECT ?, ?, id FROM label WHERE id = ?')
      for (const id of labelIds) ins.run(m.account_id, m.message_id, id)
    })()
  }

  setFollowUp(id: string, due: number): void {
    this.db
      .prepare('INSERT INTO followup (message_id, due, fired) VALUES (?, ?, 0) ON CONFLICT(message_id) DO UPDATE SET due = excluded.due, fired = 0')
      .run(id, due)
  }

  /** Remembers a reminder for a message that has just been sent, by its Message-ID. */
  addPendingFollowUp(accountId: string, rfcId: string, due: number, now = Date.now()): void {
    this.db
      .prepare('INSERT OR REPLACE INTO pending_followup (account_id, rfc_id, due, created_at) VALUES (?, ?, ?, ?)')
      .run(accountId, rfcId, due, now)
  }

  clearFollowUp(id: string): void {
    this.db.prepare('DELETE FROM followup WHERE message_id = ?').run(id)
  }

  followUpAt(id: string): number | null {
    return (
      (this.db.prepare('SELECT due FROM followup WHERE message_id = ?').get(id) as { due: number } | undefined)?.due ?? null
    )
  }

  /**
   * Drops reminders whose conversation got a reply from someone else, then marks the reminders
   * that are now due as shown and returns their message ids (each is returned once).
   */
  followUpTick(now: number): string[] {
    return this.db.transaction(() => {
      // Reminders chosen while sending attach to the sent copy once the Sent folder has it.
      this.db
        .prepare(
          `INSERT OR IGNORE INTO followup (message_id, due, fired)
           SELECT m.id, p.due, 0 FROM pending_followup p
             JOIN message m ON m.account_id = p.account_id AND m.message_id = p.rfc_id
             JOIN folder f ON f.id = m.folder_id AND f.role = 'sent'`
        )
        .run()
      this.db
        .prepare(
          `DELETE FROM pending_followup WHERE created_at < ? OR EXISTS (
             SELECT 1 FROM message m JOIN folder f ON f.id = m.folder_id AND f.role = 'sent'
              WHERE m.account_id = pending_followup.account_id AND m.message_id = pending_followup.rfc_id)`
        )
        .run(now - 30 * 24 * 3600 * 1000)
      this.db
        .prepare(
          `DELETE FROM followup WHERE message_id IN (
             SELECT m0.message_id FROM followup m0 JOIN message m ON m.id = m0.message_id
              WHERE m.thread_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM message t WHERE t.thread_id = m.thread_id AND t.date > m.date
                   AND lower(t.from_addr) NOT IN ${OWN}))`
        )
        .run()
      const ids = (
        this.db.prepare('SELECT message_id FROM followup WHERE due <= ? AND fired = 0 ORDER BY due').all(now) as {
          message_id: string
        }[]
      ).map((r) => r.message_id)
      const mark = this.db.prepare('UPDATE followup SET fired = 1 WHERE message_id = ?')
      ids.forEach((id) => mark.run(id))
      return ids
    })()
  }

  /** Sent messages as notification items: who you wrote to rather than who wrote. */
  sentItems(ids: string[]): ReturnType<MailStore['incoming']> {
    const get = this.db.prepare('SELECT id, to_addrs, subject, date FROM message WHERE id = ?')
    const out: ReturnType<MailStore['incoming']> = []
    for (const id of ids) {
      const r = get.get(id) as { id: string; to_addrs: string; subject: string; date: number } | undefined
      if (!r) continue
      out.push({ id: r.id, fromName: r.to_addrs.split(',')[0]!.replace(/<.*>/, '').trim(), fromAddr: r.to_addrs, subject: r.subject, category: 'other', risk: 'none', date: r.date, unread: true })
    }
    return out
  }

  /** Tells the scam shield a message is fine (or takes that back). */
  setRiskSafe(id: string, safe: boolean): void {
    this.db.prepare('UPDATE message SET risk_safe = ? WHERE id = ?').run(safe ? 1 : 0, id)
  }

  /** Classifies mail cached before categories existed. Returns how many were filed. */
  backfillCategories(limit = 5000): number {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.from_addr, m.from_name, m.subject, b.text
           FROM message m LEFT JOIN message_body b ON b.message_id = m.id
          WHERE m.category IS NULL OR m.risk IS NULL LIMIT ?`
      )
      .all(limit) as { id: string; from_addr: string; from_name: string; subject: string; text: string | null }[]
    const set = this.db.prepare(
      'UPDATE message SET category = ?, risk = ?, risk_reasons = ? WHERE id = ?'
    )
    this.db.transaction(() => {
      for (const r of rows) {
        const category = classify({
          fromAddr: r.from_addr,
          fromName: r.from_name,
          subject: r.subject,
          text: r.text ?? undefined
        }).category
        const cols = riskColumns({
          fromAddr: r.from_addr,
          fromName: r.from_name,
          subject: r.subject,
          text: r.text ?? undefined
        })
        set.run(category, cols.risk, cols.riskReasons, r.id)
      }
    })()
    return rows.length
  }

  viewCounts(now = Date.now()): ViewCounts {
    const since = now - REPLY_WINDOW_MS
    const waitBefore = now - WAIT_AFTER_MS
    const count = (cond: string) =>
      (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM message m JOIN folder f ON f.id = m.folder_id WHERE ${cond}`
          )
          .get({ since, waitBefore }) as { n: number }
      ).n
    const cats = this.db
      .prepare(
        `SELECT ${EFFECTIVE_CATEGORY} AS category, COUNT(*) AS total,
                COALESCE(SUM(instr(m.flags, '${SEEN}') = 0), 0) AS unread
           FROM message m JOIN folder f ON f.id = m.folder_id
          WHERE f.role = 'inbox' AND ${NOT_SNOOZED} GROUP BY 1`
      )
      .all() as { category: Category; total: number; unread: number }[]
    return {
      needsReply: count(`${NEEDS_REPLY} AND ${NOT_SNOOZED}`),
      waiting: count(`${WAITING} AND ${NOT_SNOOZED}`),
      suspicious: count(`${SUSPICIOUS} AND ${NOT_SNOOZED}`),
      snoozed: count('EXISTS (SELECT 1 FROM snooze sz WHERE sz.message_id = m.id)'),
      followUp: count('EXISTS (SELECT 1 FROM followup fu WHERE fu.message_id = m.id)'),
      categories: cats
    }
  }

  private dealRow(r: {
    id: string
    account_id: string
    message_id: string | null
    brand: string
    stage: Deal['stage']
    rate: number | null
    currency: string
    deliverables: string
    due_date: number | null
    notes: string
    created_at: number
    updated_at: number
    paid_at: number | null
  }): Deal {
    return {
      id: r.id,
      accountId: r.account_id,
      messageId: r.message_id,
      brand: r.brand,
      stage: r.stage,
      rate: r.rate,
      currency: r.currency,
      deliverables: r.deliverables,
      dueDate: r.due_date,
      notes: r.notes,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      paidAt: r.paid_at
    }
  }

  listDeals(): Deal[] {
    return (this.db.prepare('SELECT * FROM deal ORDER BY updated_at DESC').all() as Parameters<MailStore['dealRow']>[0][]).map((r) => this.dealRow(r))
  }

  getDeal(id: string): Deal | undefined {
    const r = this.db.prepare('SELECT * FROM deal WHERE id = ?').get(id) as Parameters<MailStore['dealRow']>[0] | undefined
    return r && this.dealRow(r)
  }

  createDeal(d: { accountId: string; messageId: string | null; brand: string } & DealPatch, now = Date.now()): Deal {
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO deal (id, account_id, message_id, brand, stage, rate, currency, deliverables,
                           due_date, notes, created_at, updated_at, paid_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        d.accountId,
        d.messageId,
        d.brand,
        d.stage ?? 'lead',
        d.rate ?? null,
        d.currency ?? 'USD',
        d.deliverables ?? '',
        d.dueDate ?? null,
        d.notes ?? '',
        now,
        now,
        d.stage === 'paid' ? now : null
      )
    return this.getDeal(id)!
  }

  updateDeal(id: string, patch: DealPatch, now = Date.now()): Deal {
    const cur = this.getDeal(id)
    if (!cur) throw new Error('That deal no longer exists')
    const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Deal
    // Moving to Paid stamps the date; moving back clears it.
    const paidAt = next.stage === 'paid' ? (cur.paidAt ?? now) : null
    this.db
      .prepare(
        `UPDATE deal SET brand = ?, stage = ?, rate = ?, currency = ?, deliverables = ?, due_date = ?,
                         notes = ?, updated_at = ?, paid_at = ? WHERE id = ?`
      )
      .run(next.brand, next.stage, next.rate, next.currency, next.deliverables, next.dueDate, next.notes, now, paidAt, id)
    return this.getDeal(id)!
  }

  deleteDeal(id: string): void {
    this.db.prepare('DELETE FROM deal WHERE id = ?').run(id)
  }

  // ---- calendar --------------------------------------------------------------------

  private toEvent(r: {
    id: string
    account_id: string
    uid: string
    recurrence_id: number | null
    sequence: number
    summary: string
    description: string
    location: string
    start: number
    end: number
    all_day: number
    rrule: string | null
    exdates: string
    organizer: string | null
    attendees: string
    status: StoredEvent['status']
    online_url: string | null
    free: number
    my_response: CalendarResponse | null
    mine: number
    updated_at: number
  }): StoredEvent {
    return {
      id: r.id,
      accountId: r.account_id,
      uid: r.uid,
      sequence: r.sequence,
      recurrenceId: r.recurrence_id,
      summary: r.summary,
      description: r.description,
      location: r.location,
      start: r.start,
      end: r.end,
      allDay: r.all_day === 1,
      rrule: r.rrule,
      repeats: null,
      exdates: JSON.parse(r.exdates) as number[],
      organizer: r.organizer ? (JSON.parse(r.organizer) as StoredEvent['organizer']) : null,
      attendees: JSON.parse(r.attendees) as StoredEvent['attendees'],
      status: r.status,
      onlineUrl: r.online_url,
      free: r.free === 1,
      myResponse: r.my_response,
      mine: r.mine === 1,
      messageId: null,
      updatedAt: r.updated_at
    }
  }

  getEvent(id: string): StoredEvent | undefined {
    const r = this.db.prepare('SELECT * FROM event WHERE id = ?').get(id) as Parameters<MailStore['toEvent']>[0] | undefined
    return r && this.toEvent(r)
  }

  /** The series and any overrides of one meeting uid, oldest first. */
  eventsByUid(accountId: string, uid: string): StoredEvent[] {
    return (
      this.db
        .prepare('SELECT * FROM event WHERE account_id = ? AND uid = ? ORDER BY recurrence_id IS NOT NULL, start')
        .all(accountId, uid) as Parameters<MailStore['toEvent']>[0][]
    ).map((r) => this.toEvent(r))
  }

  putEvent(e: StoredEvent): void {
    this.db
      .prepare(
        `INSERT INTO event (id, account_id, uid, recurrence_id, sequence, summary, description, location,
            start, end, all_day, rrule, exdates, organizer, attendees, status, online_url, free,
            my_response, mine, updated_at)
         VALUES (@id, @accountId, @uid, @recurrenceId, @sequence, @summary, @description, @location,
            @start, @end, @allDay, @rrule, @exdates, @organizer, @attendees, @status, @onlineUrl, @free,
            @myResponse, @mine, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET sequence = excluded.sequence, summary = excluded.summary,
            description = excluded.description, location = excluded.location, start = excluded.start,
            end = excluded.end, all_day = excluded.all_day, rrule = excluded.rrule,
            exdates = excluded.exdates, organizer = excluded.organizer, attendees = excluded.attendees,
            status = excluded.status, online_url = excluded.online_url, free = excluded.free,
            my_response = excluded.my_response, mine = excluded.mine, updated_at = excluded.updated_at`
      )
      .run({
        id: e.id,
        accountId: e.accountId,
        uid: e.uid,
        recurrenceId: e.recurrenceId,
        sequence: e.sequence,
        summary: e.summary,
        description: e.description,
        location: e.location,
        start: e.start,
        end: e.end,
        allDay: e.allDay ? 1 : 0,
        rrule: e.rrule,
        exdates: JSON.stringify(e.exdates),
        organizer: e.organizer ? JSON.stringify(e.organizer) : null,
        attendees: JSON.stringify(e.attendees),
        status: e.status,
        onlineUrl: e.onlineUrl,
        free: e.free ? 1 : 0,
        myResponse: e.myResponse,
        mine: e.mine ? 1 : 0,
        updatedAt: e.updatedAt
      })
  }

  linkEventMessage(messageId: string, eventId: string, method: string, sequence: number): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO event_message (message_id, event_id, method, sequence) VALUES (?, ?, ?, ?)'
      )
      .run(messageId, eventId, method, sequence)
  }

  /** The meetings a message carried, with which version and method. */
  eventsForMessage(messageId: string): { event: StoredEvent; method: string; sequence: number }[] {
    return (
      this.db
        .prepare(
          `SELECT e.*, em.method AS em_method, em.sequence AS em_sequence
             FROM event_message em JOIN event e ON e.id = em.event_id
            WHERE em.message_id = ? ORDER BY e.recurrence_id IS NOT NULL, e.start`
        )
        .all(messageId) as (Parameters<MailStore['toEvent']>[0] & { em_method: string; em_sequence: number })[]
    ).map((r) => ({ event: this.toEvent(r), method: r.em_method, sequence: r.em_sequence }))
  }

  /** The most recent message that carried a meeting, for replying. */
  messageForEvent(eventId: string): string | null {
    return (
      (
        this.db
          .prepare(
            `SELECT em.message_id FROM event_message em JOIN message m ON m.id = em.message_id
              WHERE em.event_id = ? ORDER BY em.sequence DESC, m.date DESC LIMIT 1`
          )
          .get(eventId) as { message_id: string } | undefined
      )?.message_id ?? null
    )
  }

  /** Everything that could fall in a window: single meetings inside it, and every repeating series. */
  eventsInRange(from: number, to: number): StoredEvent[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM event
            WHERE status != 'CANCELLED' AND (my_response IS NULL OR my_response != 'declined')
              AND ((rrule IS NULL AND end > ? AND start < ?) OR (rrule IS NOT NULL AND start < ?))`
        )
        .all(from, to, to) as Parameters<MailStore['toEvent']>[0][]
    ).map((r) => this.toEvent(r))
  }

  deleteEvent(id: string): void {
    this.db.prepare('DELETE FROM event WHERE id = ?').run(id)
  }

  // ---- what device sync needs ------------------------------------------------------------------------
  // Local ids differ between devices, so synced data names an account by its address and a message by
  // its Message-ID header. These look both up in either direction.

  accountIdForEmail(email: string): string | undefined {
    return (this.db.prepare('SELECT id FROM account WHERE email = ? COLLATE NOCASE').get(email.trim()) as { id: string } | undefined)?.id
  }

  /** The local id of a message in this account with this Message-ID header, if it has been downloaded. */
  messageIdForRfc(accountId: string, rfcId: string): string | undefined {
    return (this.db.prepare('SELECT id FROM message WHERE account_id = ? AND message_id = ? LIMIT 1').get(accountId, rfcId) as { id: string } | undefined)?.id
  }

  rfcIdOfMessage(id: string): string | undefined {
    return (this.db.prepare('SELECT message_id AS rfc FROM message WHERE id = ?').get(id) as { rfc: string } | undefined)?.rfc
  }

  snoozeRows(): { email: string; rfcId: string; until: number }[] {
    return this.db
      .prepare('SELECT a.email AS email, m.message_id AS rfcId, s.until AS until FROM snooze s JOIN message m ON m.id = s.message_id JOIN account a ON a.id = m.account_id')
      .all() as { email: string; rfcId: string; until: number }[]
  }

  followUpRows(): { email: string; rfcId: string; due: number; fired: boolean }[] {
    return (
      this.db
        .prepare('SELECT a.email AS email, m.message_id AS rfcId, f.due AS due, f.fired AS fired FROM followup f JOIN message m ON m.id = f.message_id JOIN account a ON a.id = m.account_id')
        .all() as { email: string; rfcId: string; due: number; fired: number }[]
    ).map((r) => ({ ...r, fired: r.fired === 1 }))
  }

  putFollowUp(messageId: string, due: number, fired: boolean): void {
    this.db
      .prepare('INSERT INTO followup (message_id, due, fired) VALUES (?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET due = excluded.due, fired = excluded.fired')
      .run(messageId, due, fired ? 1 : 0)
  }

  messageLabelRows(): { email: string; rfcId: string; labelId: string }[] {
    return this.db
      .prepare('SELECT a.email AS email, ml.rfc_id AS rfcId, ml.label_id AS labelId FROM message_label ml JOIN account a ON a.id = ml.account_id')
      .all() as { email: string; rfcId: string; labelId: string }[]
  }

  /** Puts a label on a message by its Message-ID. False if the label does not exist here (yet). */
  putMessageLabel(accountId: string, rfcId: string, labelId: string): boolean {
    if (!this.db.prepare('SELECT 1 FROM label WHERE id = ?').get(labelId)) return false
    this.db.prepare('INSERT OR IGNORE INTO message_label (account_id, rfc_id, label_id) VALUES (?, ?, ?)').run(accountId, rfcId, labelId)
    return true
  }

  removeMessageLabel(accountId: string, rfcId: string, labelId: string): void {
    this.db.prepare('DELETE FROM message_label WHERE account_id = ? AND rfc_id = ? AND label_id = ?').run(accountId, rfcId, labelId)
  }

  /** Creates or updates a deal under the id it already has (it came from another device). */
  putDeal(d: Deal): void {
    this.db
      .prepare(
        `INSERT INTO deal (id, account_id, message_id, brand, stage, rate, currency, deliverables, due_date, notes, created_at, updated_at, paid_at)
         VALUES (@id, @accountId, @messageId, @brand, @stage, @rate, @currency, @deliverables, @dueDate, @notes, @createdAt, @updatedAt, @paidAt)
         ON CONFLICT(id) DO UPDATE SET message_id = excluded.message_id, brand = excluded.brand, stage = excluded.stage, rate = excluded.rate,
           currency = excluded.currency, deliverables = excluded.deliverables, due_date = excluded.due_date, notes = excluded.notes,
           updated_at = excluded.updated_at, paid_at = excluded.paid_at`
      )
      .run({ ...d })
  }

  allEvents(): StoredEvent[] {
    return (this.db.prepare('SELECT * FROM event ORDER BY start').all() as Parameters<MailStore['toEvent']>[0][]).map((r) => this.toEvent(r))
  }

  // ---- the account's own calendar (read-only copies) ----------------------------------

  /** Swaps what is stored for the window [from, to) with what the calendar returned, in one step. */
  replaceRemoteEvents(accountId: string, from: number, to: number, events: RemoteEvent[]): void {
    const del = this.db.prepare('DELETE FROM remote_event WHERE account_id = ? AND end > ? AND start < ?')
    const put = this.db.prepare(
      `INSERT OR REPLACE INTO remote_event
         (id, account_id, uid, summary, description, location, start, end, all_day, status, online_url, organizer, attendees, my_response, mine, free)
       VALUES (@id, @accountId, @uid, @summary, @description, @location, @start, @end, @allDay, @status, @onlineUrl, @organizer, @attendees, @myResponse, @mine, @free)`
    )
    this.db.transaction(() => {
      del.run(accountId, from, to)
      for (const e of events) {
        put.run({
          id: `${accountId}:${e.remoteId}`,
          accountId,
          uid: e.uid,
          summary: e.summary,
          description: e.description,
          location: e.location,
          start: e.start,
          end: e.end,
          allDay: e.allDay ? 1 : 0,
          status: e.status,
          onlineUrl: e.onlineUrl,
          organizer: e.organizer ? JSON.stringify(e.organizer) : null,
          attendees: JSON.stringify(e.attendees),
          myResponse: e.myResponse,
          mine: e.mine ? 1 : 0,
          free: e.free ? 1 : 0
        })
      }
    })()
  }

  remoteEventsInRange(from: number, to: number): StoredRemoteEvent[] {
    const rows = this.db.prepare('SELECT * FROM remote_event WHERE end > ? AND start < ? ORDER BY start').all(from, to) as {
      id: string
      account_id: string
      uid: string
      summary: string
      description: string
      location: string
      start: number
      end: number
      all_day: number
      status: 'CONFIRMED' | 'TENTATIVE'
      online_url: string | null
      organizer: string | null
      attendees: string
      my_response: CalendarEvent['myResponse']
      mine: number
      free: number
    }[]
    return rows.map((r) => ({
      id: r.id,
      accountId: r.account_id,
      uid: r.uid,
      summary: r.summary,
      description: r.description,
      location: r.location,
      start: r.start,
      end: r.end,
      allDay: r.all_day === 1,
      status: r.status,
      onlineUrl: r.online_url,
      organizer: r.organizer ? (JSON.parse(r.organizer) as StoredRemoteEvent['organizer']) : null,
      attendees: JSON.parse(r.attendees) as StoredRemoteEvent['attendees'],
      myResponse: r.my_response,
      mine: r.mine === 1,
      free: r.free === 1
    }))
  }

  clearRemoteEvents(accountId: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM remote_event WHERE account_id = ?').run(accountId)
      this.db.prepare('DELETE FROM remote_sync WHERE account_id = ?').run(accountId)
    })()
  }

  setRemoteSync(accountId: string, syncedAt: number | null, error: string | null): void {
    this.db
      .prepare(
        `INSERT INTO remote_sync (account_id, synced_at, error) VALUES (?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET synced_at = COALESCE(excluded.synced_at, synced_at), error = excluded.error`
      )
      .run(accountId, syncedAt, error)
  }

  remoteSyncStates(): { accountId: string; syncedAt: number | null; error: string | null }[] {
    return (this.db.prepare('SELECT account_id, synced_at, error FROM remote_sync').all() as { account_id: string; synced_at: number | null; error: string | null }[]).map(
      (r) => ({ accountId: r.account_id, syncedAt: r.synced_at, error: r.error })
    )
  }

  messageHasInvite(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM event_message WHERE message_id = ?').get(id)
  }

  // ---- templates ------------------------------------------------------------------

  listTemplates(): Template[] {
    return (
      this.db.prepare('SELECT * FROM template ORDER BY name COLLATE NOCASE').all() as {
        id: string
        name: string
        subject: string
        html: string
        attachments: string
        updated_at: number
      }[]
    ).map((r) => ({
      id: r.id,
      name: r.name,
      subject: r.subject,
      html: r.html,
      attachments: JSON.parse(r.attachments) as Template['attachments'],
      updatedAt: r.updated_at
    }))
  }

  putTemplate(t: Template): void {
    this.db
      .prepare(
        `INSERT INTO template (id, name, subject, html, attachments, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, subject = excluded.subject,
           html = excluded.html, attachments = excluded.attachments, updated_at = excluded.updated_at`
      )
      .run(t.id, t.name, t.subject, t.html, JSON.stringify(t.attachments), t.updatedAt)
  }

  deleteTemplate(id: string): void {
    this.db.prepare('DELETE FROM template WHERE id = ?').run(id)
  }

  // ---- compose: signatures, drafts, outbox, contacts ---------------------------

  setDisplayName(accountId: string, displayName: string): void {
    this.db.prepare('UPDATE account SET display_name = ? WHERE id = ?').run(displayName.trim(), accountId)
  }

  setSignature(accountId: string, signature: string): void {
    this.db.prepare('UPDATE account SET signature = ? WHERE id = ?').run(signature, accountId)
  }

  saveDraft(id: string, accountId: string, payload: string): void {
    this.db
      .prepare(
        `INSERT INTO draft (id, account_id, payload, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id,
                                       payload = excluded.payload,
                                       updated_at = excluded.updated_at`
      )
      .run(id, accountId, payload, Date.now())
  }

  getDraft(id: string): string | undefined {
    return (
      this.db.prepare('SELECT payload FROM draft WHERE id = ?').get(id) as
        | { payload: string }
        | undefined
    )?.payload
  }

  listDrafts(): { id: string; accountId: string; payload: string; updatedAt: number }[] {
    return (
      this.db
        .prepare('SELECT id, account_id, payload, updated_at FROM draft ORDER BY updated_at DESC')
        .all() as { id: string; account_id: string; payload: string; updated_at: number }[]
    ).map((r) => ({
      id: r.id,
      accountId: r.account_id,
      payload: r.payload,
      updatedAt: r.updated_at
    }))
  }

  deleteDraft(id: string): void {
    this.db.prepare('DELETE FROM draft WHERE id = ?').run(id)
  }

  queueOutbox(o: {
    id: string
    accountId: string
    payload: string
    sendAt: number
    subject: string
    to: string[]
    createdAt?: number
  }): void {
    this.db
      .prepare(
        `INSERT INTO outbox (id, account_id, payload, send_at, state, subject, to_text, created_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`
      )
      .run(o.id, o.accountId, o.payload, o.sendAt, o.subject, JSON.stringify(o.to), o.createdAt ?? Date.now())
  }

  getOutbox(id: string):
    | {
        id: string
        accountId: string
        payload: string
        sendAt: number
        state: 'queued' | 'sending' | 'sent' | 'failed'
        error: string | null
        subject: string
        to: string[]
        createdAt: number
      }
    | undefined {
    const r = this.db.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as
      | {
          id: string
          account_id: string
          payload: string
          send_at: number
          state: 'queued' | 'sending' | 'sent' | 'failed'
          error: string | null
          subject: string
          to_text: string
          created_at: number
        }
      | undefined
    return (
      r && {
        createdAt: r.created_at,
        id: r.id,
        accountId: r.account_id,
        payload: r.payload,
        sendAt: r.send_at,
        state: r.state,
        error: r.error,
        subject: r.subject,
        to: JSON.parse(r.to_text) as string[]
      }
    )
  }

  setOutboxState(id: string, state: 'queued' | 'sending' | 'sent' | 'failed', error: string | null = null): void {
    this.db.prepare('UPDATE outbox SET state = ?, error = ? WHERE id = ?').run(state, error, id)
  }

  deleteOutbox(id: string): void {
    this.db.prepare('DELETE FROM outbox WHERE id = ?').run(id)
  }

  /** Queued items whose undo window has passed, plus any left 'sending' by a crash. */
  dueOutbox(now: number): string[] {
    return (
      this.db
        .prepare(
          `SELECT id FROM outbox WHERE (state = 'queued' AND send_at <= ?) OR state = 'sending'
            ORDER BY send_at`
        )
        .all(now) as { id: string }[]
    ).map((r) => r.id)
  }

  listOutbox(now: number): ReturnType<MailStore['getOutbox']>[] {
    // 'sent' rows only linger a minute so the UI can confirm them.
    this.db.prepare("DELETE FROM outbox WHERE state = 'sent' AND created_at < ?").run(now - 60_000)
    const ids = this.db.prepare('SELECT id FROM outbox ORDER BY created_at').all() as { id: string }[]
    return ids.map((r) => this.getOutbox(r.id))
  }

  /** People you have mail with: senders, ranked by volume, plus recipients of your sent mail. */
  searchContacts(q: string, limit = 8): { name: string; address: string }[] {
    const like = `%${q.replace(/[%_]/g, '')}%`
    const seen = new Map<string, { name: string; address: string; n: number }>()
    const add = (name: string, address: string, weight: number) => {
      const key = address.toLowerCase()
      if (!key.includes('@')) return
      const cur = seen.get(key)
      if (cur) {
        cur.n += weight
        if (!cur.name && name) cur.name = name
      } else seen.set(key, { name, address, n: weight })
    }
    const senders = this.db
      .prepare(
        `SELECT from_name, from_addr, COUNT(*) AS c FROM message
          WHERE from_addr LIKE ? OR from_name LIKE ?
          GROUP BY lower(from_addr) ORDER BY c DESC LIMIT 50`
      )
      .all(like, like) as { from_name: string; from_addr: string; c: number }[]
    for (const s of senders) add(s.from_name, s.from_addr, s.c)
    const sent = this.db
      .prepare(
        `SELECT m.to_addrs FROM message m JOIN folder f ON f.id = m.folder_id
          WHERE f.role = 'sent' AND m.to_addrs LIKE ? LIMIT 200`
      )
      .all(like) as { to_addrs: string }[]
    for (const r of sent) {
      for (const a of r.to_addrs.split(',')) {
        const address = a.trim()
        if (address.toLowerCase().includes(q.toLowerCase())) add('', address, 3)
      }
    }
    return [...seen.values()]
      .sort((a, b) => b.n - a.n)
      .slice(0, limit)
      .map(({ name, address }) => ({ name, address }))
  }

  /** Recomputes conversation membership for one account (call after its messages change). */
  rethread(accountId: string): void {
    const rows = this.db
      .prepare(
        'SELECT id, message_id, refs, subject, date, thread_id FROM message WHERE account_id = ?'
      )
      .all(accountId) as {
      id: string
      message_id: string | null
      refs: string
      subject: string
      date: number
      thread_id: string | null
    }[]
    const keys = computeThreads(
      rows.map((r) => ({
        id: r.id,
        messageId: r.message_id,
        refs: r.refs.split(' ').filter(Boolean),
        subject: r.subject,
        date: r.date
      }))
    )
    const sizes = new Map<string, number>()
    for (const k of keys.values()) sizes.set(k, (sizes.get(k) ?? 0) + 1)

    const upsertThread = this.db.prepare(
      `INSERT INTO thread (id, subject_norm, last_date) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET subject_norm = excluded.subject_norm,
                                     last_date = excluded.last_date`
    )
    const setThread = this.db.prepare('UPDATE message SET thread_id = ? WHERE id = ?')
    const byId = new Map(rows.map((r) => [r.id, r]))
    const lastDate = new Map<string, number>()
    for (const [id, key] of keys) {
      lastDate.set(key, Math.max(lastDate.get(key) ?? 0, byId.get(id)!.date))
    }

    this.db.transaction(() => {
      for (const [id, key] of keys) {
        // Standalone messages need no thread row; null keeps listMessages cheap.
        const threadId = (sizes.get(key) ?? 1) > 1 ? `${accountId}:${key}` : null
        if (threadId) {
          upsertThread.run(threadId, normalizeSubject(byId.get(key)!.subject), lastDate.get(key))
        }
        if (byId.get(id)!.thread_id !== threadId) setThread.run(threadId, id)
      }
      this.db.exec(
        'DELETE FROM thread WHERE id NOT IN (SELECT DISTINCT thread_id FROM message WHERE thread_id IS NOT NULL)'
      )
    })()
  }
}
