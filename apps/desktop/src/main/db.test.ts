import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from './db'
import { migrations } from './migrations'

describe('migrate', () => {
  it('applies all migrations once and is idempotent', () => {
    const db = new Database(':memory:')
    expect(migrate(db)).toBe(migrations.length)
    expect(db.pragma('user_version', { simple: true })).toBe(migrations.length)
    expect(() => migrate(db)).not.toThrow()
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='account'")
      .all()
    expect(tables).toHaveLength(1)
  })
})
