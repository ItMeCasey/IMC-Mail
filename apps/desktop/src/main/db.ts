import Database from 'better-sqlite3'
import { migrations } from './migrations'

export type Db = Database.Database

/** Applies pending migrations in order, each in its own transaction. Returns the schema version. */
export function migrate(db: Db, steps: readonly string[] = migrations): number {
  const current = db.pragma('user_version', { simple: true }) as number
  for (let v = current; v < steps.length; v++) {
    db.transaction(() => {
      db.exec(steps[v] as string)
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
  return steps.length
}

export function openDb(file: string): Db {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}
