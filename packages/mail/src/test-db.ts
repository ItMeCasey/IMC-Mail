import { DatabaseSync } from 'node:sqlite'
import type { SqlDb, SqlValue } from './phonedb'

/** A database in memory on Node's SQLite, standing in for the phone's, so the phone's database code can be tested. */
export function memoryDb(): SqlDb & { raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:')
  let depth = 0
  return {
    raw,
    exec: (sql) => void raw.exec(sql),
    run: (sql, ...params: SqlValue[]) => void raw.prepare(sql).run(...params),
    all: <T>(sql: string, ...params: SqlValue[]) => raw.prepare(sql).all(...params) as T[],
    first: <T>(sql: string, ...params: SqlValue[]) => (raw.prepare(sql).get(...params) as T | undefined) ?? null,
    transaction: (fn) => {
      if (depth > 0) return fn()
      depth++
      raw.exec('BEGIN')
      try {
        fn()
        raw.exec('COMMIT')
      } catch (e) {
        raw.exec('ROLLBACK')
        throw e
      } finally {
        depth--
      }
    }
  }
}
