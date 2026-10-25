import { randomUUID } from 'node:crypto'
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

export interface BodyRow {
  html: string | null
  text: string
  to: string
  cc: string
  attachments: Attachment[]
  truncated: boolean
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
}

const SEEN = '\\Seen'
const FLAGGED = '\\Flagged'

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

  // ---- messages ----------------------------------------------------------

  /** Wipes a folder's cached messages, used when UIDVALIDITY changes. */
  clearFolder(folderId: string): void {
    this.db.prepare('DELETE FROM message WHERE folder_id = ?').run(folderId)
  }

  /** The lowest UID of the newest `window` cached messages, or null if the folder is empty. */
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
  ): void {
    const upsert = this.db.prepare(
      `INSERT INTO message
         (id, account_id, folder_id, uid, message_id, from_name, from_addr, to_addrs,
          subject, date, flags, refs)
       VALUES (@id, @accountId, @folderId, @uid, @messageId, @fromName, @fromAddr, @to,
               @subject, @date, @flags, @refs)
       ON CONFLICT(folder_id, uid) DO UPDATE SET flags = excluded.flags, refs = excluded.refs`
    )
    this.db.transaction(() => {
      for (const m of fetched) {
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
          refs: m.refs.join(' ')
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
  }

  listMessages(q: {
    accountId?: string
    folderId?: string
    limit: number
    offset: number
  }): MessageSummary[] {
    const where: string[] = []
    const args: Record<string, unknown> = { limit: q.limit, offset: q.offset }
    if (q.folderId) {
      where.push('m.folder_id = @folderId')
      args.folderId = q.folderId
    } else {
      where.push("f.role = 'inbox'")
      if (q.accountId) {
        where.push('m.account_id = @accountId')
        args.accountId = q.accountId
      }
    }
    const rows = this.db
      .prepare(
        `SELECT m.id, m.account_id, m.folder_id, m.uid, m.from_name, m.from_addr,
                m.subject, m.date, m.flags,
                CASE WHEN m.thread_id IS NULL THEN 1
                     ELSE (SELECT COUNT(*) FROM message t WHERE t.thread_id = m.thread_id) END
                  AS thread_size
           FROM message m JOIN folder f ON f.id = m.folder_id
          WHERE ${where.join(' AND ')}
          ORDER BY m.date DESC, m.uid DESC
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
      threadSize: r.thread_size
    }))
  }

  // ---- single messages, bodies, threads ------------------------------------

  getMessage(id: string): MessageRow | undefined {
    const r = this.db
      .prepare(
        `SELECT m.id, m.account_id, m.folder_id, f.path AS folder_path, m.uid, m.thread_id,
                m.from_name, m.from_addr, m.to_addrs, m.subject, m.date, m.flags, m.snippet
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
        }
      | undefined
    return (
      r && {
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
        }
      | undefined
    return (
      r && {
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
             (message_id, html, text, to_text, cc_text, attachments, truncated, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          body.html,
          body.text,
          body.to,
          body.cc,
          JSON.stringify(body.attachments),
          body.truncated ? 1 : 0,
          Date.now()
        )
      this.db.prepare('UPDATE message SET snippet = ? WHERE id = ?').run(snippet, id)
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
