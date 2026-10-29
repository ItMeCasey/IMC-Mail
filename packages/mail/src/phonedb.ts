import { parseSyncData, syncTypes, type SyncAdapter, type SyncItem, type SyncStorage, type SyncType } from '@imc/core'
import type { AttachmentInfo } from './message'
import type { Summary, Folder } from './imap'
import type { FolderState, MailCache } from './mailbox'

// The phone's local database, written against a small interface so the same code runs on the phone's SQLite and,
// in tests, on Node's. It holds the saved message lists and bodies, the folder lists, the items synced from your other
// devices, the sync bookkeeping, and mail waiting to be sent.

export type SqlValue = string | number | null | Uint8Array

export interface SqlDb {
  exec(sql: string): void
  run(sql: string, ...params: SqlValue[]): void
  all<T>(sql: string, ...params: SqlValue[]): T[]
  first<T>(sql: string, ...params: SqlValue[]): T | null
  /** Runs `fn` as one unit: all of it happens or none of it does. */
  transaction(fn: () => void): void
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS message (
  account TEXT NOT NULL, folder TEXT NOT NULL, uid INTEGER NOT NULL,
  flags TEXT NOT NULL, internal_date TEXT, size INTEGER NOT NULL,
  from_json TEXT, to_json TEXT NOT NULL, cc_json TEXT NOT NULL,
  subject TEXT NOT NULL, message_id TEXT, in_reply_to TEXT, refs TEXT NOT NULL, date INTEGER,
  remote_id TEXT,
  PRIMARY KEY (account, folder, uid)
);
CREATE INDEX IF NOT EXISTS message_date ON message (account, folder, date DESC);
CREATE TABLE IF NOT EXISTS folder_state (
  account TEXT NOT NULL, folder TEXT NOT NULL,
  uid_validity INTEGER NOT NULL, highest_uid INTEGER NOT NULL, synced_at INTEGER NOT NULL,
  PRIMARY KEY (account, folder)
);
CREATE TABLE IF NOT EXISTS body (
  account TEXT NOT NULL, folder TEXT NOT NULL, uid INTEGER NOT NULL,
  text TEXT NOT NULL, html TEXT, attachments TEXT NOT NULL, truncated INTEGER NOT NULL, cached_at INTEGER NOT NULL,
  PRIMARY KEY (account, folder, uid)
);
CREATE TABLE IF NOT EXISTS folder (
  account TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL, delimiter TEXT, flags TEXT NOT NULL,
  special_use TEXT, selectable INTEGER NOT NULL, position INTEGER NOT NULL,
  PRIMARY KEY (account, path)
);
CREATE TABLE IF NOT EXISTS item (
  type TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (type, id)
);
CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sync_item (
  type TEXT NOT NULL, id TEXT NOT NULL, hash TEXT NOT NULL, hlc TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (type, id)
);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, account TEXT NOT NULL, sender TEXT NOT NULL, recipients TEXT NOT NULL,
  raw BLOB NOT NULL, subject TEXT NOT NULL, created_at INTEGER NOT NULL, error TEXT
);
`

/** Creates the tables, and adds what an older copy of the database is missing. Safe to run every time. */
export function migrate(db: SqlDb): void {
  db.exec(SCHEMA)
  const cols = db.all<{ name: string }>('PRAGMA table_info(message)')
  if (!cols.some((c) => c.name === 'remote_id')) db.exec('ALTER TABLE message ADD COLUMN remote_id TEXT')
}

// ---- saved message lists ---------------------------------------------------------------------------------------------

interface Row {
  uid: number
  flags: string
  internal_date: string | null
  size: number
  from_json: string | null
  to_json: string
  cc_json: string
  subject: string
  message_id: string | null
  in_reply_to: string | null
  refs: string
  date: number | null
  remote_id: string | null
}

const toSummary = (r: Row): Summary => ({
  uid: r.uid,
  flags: JSON.parse(r.flags) as string[],
  internalDate: r.internal_date,
  size: r.size,
  from: r.from_json ? (JSON.parse(r.from_json) as Summary['from']) : null,
  to: JSON.parse(r.to_json) as Summary['to'],
  cc: JSON.parse(r.cc_json) as Summary['cc'],
  subject: r.subject,
  messageId: r.message_id,
  inReplyTo: r.in_reply_to,
  references: JSON.parse(r.refs) as string[],
  date: r.date,
  ...(r.remote_id ? { remoteId: r.remote_id } : {})
})

/** The saved message lists, for `syncFolder` and `syncPop3`. */
export function messageCache(db: SqlDb): MailCache & { recent(account: string, folder: string, limit: number): Promise<Summary[]> } {
  return {
    async folderState(account, folder) {
      const r = db.first<{ uid_validity: number; highest_uid: number; synced_at: number }>('SELECT uid_validity, highest_uid, synced_at FROM folder_state WHERE account = ? AND folder = ?', account, folder)
      return r ? ({ uidValidity: r.uid_validity, highestUid: r.highest_uid, syncedAt: r.synced_at } satisfies FolderState) : null
    },
    async setFolderState(account, folder, s) {
      db.run(
        'INSERT INTO folder_state (account, folder, uid_validity, highest_uid, synced_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account, folder) DO UPDATE SET uid_validity = excluded.uid_validity, highest_uid = excluded.highest_uid, synced_at = excluded.synced_at',
        account,
        folder,
        s.uidValidity,
        s.highestUid,
        s.syncedAt
      )
    },
    async summaries(account, folder) {
      return db.all<Row>('SELECT * FROM message WHERE account = ? AND folder = ? ORDER BY uid DESC', account, folder).map(toSummary)
    },
    async index(account, folder) {
      return db.all<{ uid: number; flags: string }>('SELECT uid, flags FROM message WHERE account = ? AND folder = ?', account, folder).map((r) => ({ uid: r.uid, flags: JSON.parse(r.flags) as string[] }))
    },
    async recent(account, folder, limit) {
      return db.all<Row>('SELECT * FROM message WHERE account = ? AND folder = ? ORDER BY uid DESC LIMIT ?', account, folder, limit).map(toSummary)
    },
    async upsert(account, folder, list) {
      db.transaction(() => {
        for (const m of list)
          db.run(
            'INSERT INTO message (account, folder, uid, flags, internal_date, size, from_json, to_json, cc_json, subject, message_id, in_reply_to, refs, date, remote_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account, folder, uid) DO UPDATE SET flags = excluded.flags, subject = excluded.subject, date = excluded.date',
            account,
            folder,
            m.uid,
            JSON.stringify(m.flags),
            m.internalDate,
            m.size,
            m.from ? JSON.stringify(m.from) : null,
            JSON.stringify(m.to),
            JSON.stringify(m.cc),
            m.subject,
            m.messageId,
            m.inReplyTo,
            JSON.stringify(m.references),
            m.date,
            m.remoteId ?? null
          )
      })
    },
    async setFlags(account, folder, flags) {
      db.transaction(() => {
        for (const [uid, f] of flags) db.run('UPDATE message SET flags = ? WHERE account = ? AND folder = ? AND uid = ?', JSON.stringify(f), account, folder, uid)
      })
    },
    async remove(account, folder, uids) {
      db.transaction(() => {
        for (const uid of uids) {
          db.run('DELETE FROM message WHERE account = ? AND folder = ? AND uid = ?', account, folder, uid)
          db.run('DELETE FROM body WHERE account = ? AND folder = ? AND uid = ?', account, folder, uid)
        }
      })
    },
    async clear(account, folder) {
      db.transaction(() => {
        db.run('DELETE FROM message WHERE account = ? AND folder = ?', account, folder)
        db.run('DELETE FROM body WHERE account = ? AND folder = ?', account, folder)
        db.run('DELETE FROM folder_state WHERE account = ? AND folder = ?', account, folder)
      })
    }
  }
}

// ---- message bodies --------------------------------------------------------------------------------------------------

export interface CachedBody {
  text: string
  html: string | null
  attachments: AttachmentInfo[]
  truncated: boolean
}

/** Messages kept with their body. The oldest opened ones are dropped past this. */
export const KEEP_BODIES = 300

export function bodyCache(db: SqlDb, now: () => number = Date.now) {
  return {
    get(account: string, folder: string, uid: number): CachedBody | null {
      const r = db.first<{ text: string; html: string | null; attachments: string; truncated: number }>('SELECT text, html, attachments, truncated FROM body WHERE account = ? AND folder = ? AND uid = ?', account, folder, uid)
      return r ? { text: r.text, html: r.html, attachments: JSON.parse(r.attachments) as AttachmentInfo[], truncated: r.truncated === 1 } : null
    },
    has(account: string, folder: string, uid: number): boolean {
      return db.first<{ one: number }>('SELECT 1 AS one FROM body WHERE account = ? AND folder = ? AND uid = ?', account, folder, uid) !== null
    },
    put(account: string, folder: string, uid: number, b: CachedBody): void {
      db.transaction(() => {
        db.run(
          'INSERT INTO body (account, folder, uid, text, html, attachments, truncated, cached_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account, folder, uid) DO UPDATE SET text = excluded.text, html = excluded.html, attachments = excluded.attachments, truncated = excluded.truncated, cached_at = excluded.cached_at',
          account,
          folder,
          uid,
          b.text,
          b.html,
          JSON.stringify(b.attachments),
          b.truncated ? 1 : 0,
          now()
        )
        db.run('DELETE FROM body WHERE rowid IN (SELECT rowid FROM body ORDER BY cached_at DESC, rowid DESC LIMIT -1 OFFSET ?)', KEEP_BODIES)
      })
    },
    /** Removes everything saved for an account (when it is removed from the phone). */
    forgetAccount(account: string): void {
      db.transaction(() => {
        for (const table of ['message', 'folder_state', 'body', 'folder']) db.run(`DELETE FROM ${table} WHERE account = ?`, account)
      })
    }
  }
}

// ---- folder lists ----------------------------------------------------------------------------------------------------

export function folderCache(db: SqlDb) {
  return {
    get(account: string): Folder[] {
      return db
        .all<{ path: string; name: string; delimiter: string | null; flags: string; special_use: string | null; selectable: number }>('SELECT path, name, delimiter, flags, special_use, selectable FROM folder WHERE account = ? ORDER BY position', account)
        .map((r) => ({ path: r.path, name: r.name, delimiter: r.delimiter, flags: JSON.parse(r.flags) as string[], specialUse: r.special_use as Folder['specialUse'], selectable: r.selectable === 1 }))
    },
    set(account: string, folders: Folder[]): void {
      db.transaction(() => {
        db.run('DELETE FROM folder WHERE account = ?', account)
        folders.forEach((f, i) => db.run('INSERT INTO folder (account, path, name, delimiter, flags, special_use, selectable, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', account, f.path, f.name, f.delimiter, JSON.stringify(f.flags), f.specialUse, f.selectable ? 1 : 0, i))
      })
    }
  }
}

// ---- items synced from other devices ---------------------------------------------------------------------------------

/**
 * Labels, rules, saved searches, templates, deals, snoozes, follow-ups, meetings and preferences, kept as they were
 * synced (as JSON, by kind and id). Things that belong to an account or message are keyed by the account's address and
 * the Message-ID, so they are stored whether or not that account is on this phone.
 */
export function itemStore(db: SqlDb) {
  return {
    list<T = unknown>(type: SyncType): { id: string; data: T }[] {
      return db.all<{ id: string; data: string }>('SELECT id, data FROM item WHERE type = ? ORDER BY id', type).map((r) => ({ id: r.id, data: JSON.parse(r.data) as T }))
    },
    get<T = unknown>(type: SyncType, id: string): T | null {
      const r = db.first<{ data: string }>('SELECT data FROM item WHERE type = ? AND id = ?', type, id)
      return r ? (JSON.parse(r.data) as T) : null
    },
    put(type: SyncType, id: string, data: unknown): void {
      db.run('INSERT INTO item (type, id, data) VALUES (?, ?, ?) ON CONFLICT(type, id) DO UPDATE SET data = excluded.data', type, id, JSON.stringify(data))
    },
    remove(type: SyncType, id: string): void {
      db.run('DELETE FROM item WHERE type = ? AND id = ?', type, id)
    }
  }
}

/** The sync adapters for the phone: every kind is stored as it came, after being checked. */
export function phoneAdapters(db: SqlDb): SyncAdapter[] {
  const items = itemStore(db)
  // Account names are not synced by any device yet, so there is nothing to keep for them.
  return syncTypes
    .filter((type) => type !== 'accountName')
    .map(
    (type): SyncAdapter => ({
      type,
      list: () => items.list(type),
      parse: (data) => {
        // The id is not known here; preferences are checked against both of their shapes by id when stored.
        return type === 'pref' ? (data && typeof data === 'object' ? data : null) : parseSyncData(type, '', data)
      },
      upsert: (id, data) => {
        const checked = parseSyncData(type, id, data)
        if (checked === null) return false
        items.put(type, id, checked)
        return true
      },
      remove: (id) => items.remove(type, id)
    })
  )
}

/** The sync bookkeeping of this device (see `SyncClient`). Keys and tokens are not here: they live in the system keystore. */
export function syncStorage(db: SqlDb): SyncStorage {
  const row = (r: { type: string; id: string; hash: string; hlc: string; deleted: number }): SyncItem => ({ type: r.type as SyncType, id: r.id, hash: r.hash, hlc: r.hlc, deleted: r.deleted === 1 })
  type R = Parameters<typeof row>[0]
  return {
    get: (key) => db.first<{ value: string }>('SELECT value FROM sync_state WHERE key = ?', key)?.value ?? null,
    set: (key, value) => db.run('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value),
    remove: (key) => db.run('DELETE FROM sync_state WHERE key = ?', key),
    item: (type, id) => {
      const r = db.first<R>('SELECT type, id, hash, hlc, deleted FROM sync_item WHERE type = ? AND id = ?', type, id)
      return r ? row(r) : null
    },
    items: (type) => db.all<R>('SELECT type, id, hash, hlc, deleted FROM sync_item WHERE type = ?', type).map(row),
    putItem: (i) =>
      db.run('INSERT INTO sync_item (type, id, hash, hlc, deleted) VALUES (?, ?, ?, ?, ?) ON CONFLICT(type, id) DO UPDATE SET hash = excluded.hash, hlc = excluded.hlc, deleted = excluded.deleted', i.type, i.id, i.hash, i.hlc, i.deleted ? 1 : 0),
    clear: () => {
      db.exec('DELETE FROM sync_state; DELETE FROM sync_item;')
    }
  }
}

// ---- settings of this phone only -------------------------------------------------------------------------------------

export interface PhoneSettings {
  /** Black out the app in the recent-apps list and stop screenshots and screen recording. */
  privacyScreen: boolean
  /** Notifications say "New message" instead of who it is from and what it is about. */
  hideNotificationDetails: boolean
  /** Look for new mail now and then while the app is closed. */
  checkMailInBackground: boolean
  /** Keep a connection open to each mail server so new mail arrives at once (shows a notification while it runs). */
  liveMail: boolean
  /** Show the sender's company logo instead of initials, fetched from a favicon service (which learns the sender's domain). */
  showLogos: boolean
}

export const DEFAULT_PHONE_SETTINGS: PhoneSettings = { privacyScreen: false, hideNotificationDetails: false, checkMailInBackground: true, liveMail: false, showLogos: true }

/** Choices that belong to this phone and are not synced (the others follow you from device to device). */
export function phoneSettings(db: SqlDb) {
  const read = (key: string) => db.first<{ value: string }>('SELECT value FROM setting WHERE key = ?', key)?.value ?? null
  return {
    get(): PhoneSettings {
      const saved = read('phone')
      return { ...DEFAULT_PHONE_SETTINGS, ...(saved ? (JSON.parse(saved) as Partial<PhoneSettings>) : {}) }
    },
    set(change: Partial<PhoneSettings>): PhoneSettings {
      const next = { ...this.get(), ...change }
      db.run('INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'phone', JSON.stringify(next))
      return next
    },
    /** A small bit of state the app keeps for itself, by name. */
    getValue: read,
    setValue(key: string, value: string): void {
      db.run('INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value)
    }
  }
}

// ---- mail waiting to be sent -----------------------------------------------------------------------------------------

export interface QueuedMessage {
  id: string
  account: string
  sender: string
  recipients: string[]
  raw: Uint8Array
  subject: string
  createdAt: number
  error: string | null
}

export function outbox(db: SqlDb) {
  type R = { id: string; account: string; sender: string; recipients: string; raw: Uint8Array; subject: string; created_at: number; error: string | null }
  const toMessage = (r: R): QueuedMessage => ({ id: r.id, account: r.account, sender: r.sender, recipients: JSON.parse(r.recipients) as string[], raw: new Uint8Array(r.raw), subject: r.subject, createdAt: r.created_at, error: r.error })
  return {
    add(m: Omit<QueuedMessage, 'error'>): void {
      db.run('INSERT INTO outbox (id, account, sender, recipients, raw, subject, created_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)', m.id, m.account, m.sender, JSON.stringify(m.recipients), m.raw, m.subject, m.createdAt)
    },
    list(): QueuedMessage[] {
      return db.all<R>('SELECT * FROM outbox ORDER BY created_at').map(toMessage)
    },
    fail(id: string, error: string): void {
      db.run('UPDATE outbox SET error = ? WHERE id = ?', error, id)
    },
    remove(id: string): void {
      db.run('DELETE FROM outbox WHERE id = ?', id)
    },
    forgetAccount(account: string): void {
      db.run('DELETE FROM outbox WHERE account = ?', account)
    }
  }
}
