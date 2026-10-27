import * as SQLite from 'expo-sqlite'
import { bodyCache, folderCache, itemStore, messageCache, migrate, outbox, phoneSettings, type SqlDb, type SqlValue } from '@imc/mail'

// The phone's saved mail and synced items live in one SQLite file in the app's private storage, which other apps cannot
// read. The code that uses it is in @imc/mail (and tested there); this only connects it to the phone's SQLite.

const raw = SQLite.openDatabaseSync('imc-mail.db')

export const db: SqlDb = {
  exec: (sql) => raw.execSync(sql),
  run: (sql, ...params: SqlValue[]) => void raw.runSync(sql, params as SQLite.SQLiteBindParams),
  all: <T>(sql: string, ...params: SqlValue[]) => raw.getAllSync<T>(sql, params as SQLite.SQLiteBindParams),
  first: <T>(sql: string, ...params: SqlValue[]) => raw.getFirstSync<T>(sql, params as SQLite.SQLiteBindParams) ?? null,
  transaction: (fn) => raw.withTransactionSync(fn)
}

raw.execSync('PRAGMA journal_mode = WAL')
migrate(db)

export const cache = messageCache(db)
export const bodies = bodyCache(db)
export const folders = folderCache(db)
export const items = itemStore(db)
export const queue = outbox(db)
export const settings = phoneSettings(db)

/** Everything saved for an account, when it is removed from the phone. */
export function forgetAccount(account: string): void {
  bodies.forgetAccount(account)
  queue.forgetAccount(account)
}
