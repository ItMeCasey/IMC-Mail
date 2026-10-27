import * as SQLite from 'expo-sqlite'
import type { AttachmentInfo, FolderState, MailCache, Summary } from '@imc/mail'

// The phone's saved copy of your mail lists and of the messages you opened, so the inbox appears at once and
// works without a connection. It holds mail, so it lives in the app's private storage, which other apps cannot read.

let opened: Promise<SQLite.SQLiteDatabase> | null = null

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS message (
  account TEXT NOT NULL, folder TEXT NOT NULL, uid INTEGER NOT NULL,
  flags TEXT NOT NULL, internal_date TEXT, size INTEGER NOT NULL,
  from_json TEXT, to_json TEXT NOT NULL, cc_json TEXT NOT NULL,
  subject TEXT NOT NULL, message_id TEXT, in_reply_to TEXT, refs TEXT NOT NULL, date INTEGER,
  PRIMARY KEY (account, folder, uid)
);
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
`

export function database(): Promise<SQLite.SQLiteDatabase> {
  opened ??= SQLite.openDatabaseAsync('imc-mail.db').then(async (db) => {
    await db.execAsync(SCHEMA)
    return db
  })
  return opened
}

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
  date: r.date
})

/** The message list cache for the mail code (see `syncFolder`), kept in SQLite. */
export const sqliteCache: MailCache = {
  async folderState(account, folder) {
    const db = await database()
    const r = await db.getFirstAsync<{ uid_validity: number; highest_uid: number; synced_at: number }>('SELECT uid_validity, highest_uid, synced_at FROM folder_state WHERE account = ? AND folder = ?', account, folder)
    return r ? ({ uidValidity: r.uid_validity, highestUid: r.highest_uid, syncedAt: r.synced_at } satisfies FolderState) : null
  },
  async setFolderState(account, folder, s) {
    const db = await database()
    await db.runAsync(
      'INSERT INTO folder_state (account, folder, uid_validity, highest_uid, synced_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account, folder) DO UPDATE SET uid_validity = excluded.uid_validity, highest_uid = excluded.highest_uid, synced_at = excluded.synced_at',
      account,
      folder,
      s.uidValidity,
      s.highestUid,
      s.syncedAt
    )
  },
  async summaries(account, folder) {
    const db = await database()
    return (await db.getAllAsync<Row>('SELECT * FROM message WHERE account = ? AND folder = ? ORDER BY uid DESC', account, folder)).map(toSummary)
  },
  async upsert(account, folder, list) {
    const db = await database()
    await db.withTransactionAsync(async () => {
      for (const m of list) {
        await db.runAsync(
          'INSERT INTO message (account, folder, uid, flags, internal_date, size, from_json, to_json, cc_json, subject, message_id, in_reply_to, refs, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account, folder, uid) DO UPDATE SET flags = excluded.flags, subject = excluded.subject, date = excluded.date',
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
          m.date
        )
      }
    })
  },
  async setFlags(account, folder, flags) {
    const db = await database()
    await db.withTransactionAsync(async () => {
      for (const [uid, f] of flags) await db.runAsync('UPDATE message SET flags = ? WHERE account = ? AND folder = ? AND uid = ?', JSON.stringify(f), account, folder, uid)
    })
  },
  async remove(account, folder, uids) {
    const db = await database()
    await db.withTransactionAsync(async () => {
      for (const uid of uids) {
        await db.runAsync('DELETE FROM message WHERE account = ? AND folder = ? AND uid = ?', account, folder, uid)
        await db.runAsync('DELETE FROM body WHERE account = ? AND folder = ? AND uid = ?', account, folder, uid)
      }
    })
  },
  async clear(account, folder) {
    const db = await database()
    await db.withTransactionAsync(async () => {
      await db.runAsync('DELETE FROM message WHERE account = ? AND folder = ?', account, folder)
      await db.runAsync('DELETE FROM body WHERE account = ? AND folder = ?', account, folder)
      await db.runAsync('DELETE FROM folder_state WHERE account = ? AND folder = ?', account, folder)
    })
  }
}

export interface CachedBody {
  text: string
  html: string | null
  attachments: AttachmentInfo[]
  truncated: boolean
}

/** Messages kept with their body. The oldest opened ones are dropped past this. */
const KEEP_BODIES = 300

export async function cachedBody(account: string, folder: string, uid: number): Promise<CachedBody | null> {
  const db = await database()
  const r = await db.getFirstAsync<{ text: string; html: string | null; attachments: string; truncated: number }>('SELECT text, html, attachments, truncated FROM body WHERE account = ? AND folder = ? AND uid = ?', account, folder, uid)
  return r ? { text: r.text, html: r.html, attachments: JSON.parse(r.attachments) as AttachmentInfo[], truncated: r.truncated === 1 } : null
}

export async function saveBody(account: string, folder: string, uid: number, b: CachedBody): Promise<void> {
  const db = await database()
  await db.runAsync(
    'INSERT INTO body (account, folder, uid, text, html, attachments, truncated, cached_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account, folder, uid) DO UPDATE SET text = excluded.text, html = excluded.html, attachments = excluded.attachments, truncated = excluded.truncated, cached_at = excluded.cached_at',
    account,
    folder,
    uid,
    b.text,
    b.html,
    JSON.stringify(b.attachments),
    b.truncated ? 1 : 0,
    Date.now()
  )
  await db.runAsync('DELETE FROM body WHERE rowid IN (SELECT rowid FROM body ORDER BY cached_at DESC LIMIT -1 OFFSET ?)', KEEP_BODIES)
}

/** Removes everything saved for an account (when it is removed from the phone). */
export async function forgetAccount(account: string): Promise<void> {
  const db = await database()
  await db.withTransactionAsync(async () => {
    for (const table of ['message', 'folder_state', 'body']) await db.runAsync(`DELETE FROM ${table} WHERE account = ?`, account)
  })
}
