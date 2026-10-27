import { DatabaseSync } from 'node:sqlite'
import { isHlc, type SyncRecord, type SyncType } from '@imc/core'

/** Ceilings that keep one group (or the whole server) from growing without end. */
export const MAX_RECORDS_PER_GROUP = 20_000
export const MAX_DEVICES_PER_GROUP = 10

export interface DeviceRow {
  id: string
  publicKey: string
  name: string
  createdAt: number
  lastSeen: number
}

export interface StoredRecord extends SyncRecord {
  seq: number
}

interface RecordRow {
  seq: number
  type: string
  rid: string
  hlc: string
  deleted: number
  payload: string
}

/**
 * Everything the server keeps: which groups exist, which devices may use them, and the encrypted
 * records. It never has a key, so it cannot read a payload, only store and return it.
 */
export class SyncStore {
  private db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_group (
        id TEXT PRIMARY KEY,
        join_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS device (
        group_id TEXT NOT NULL REFERENCES sync_group(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        public_key TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        PRIMARY KEY (group_id, id)
      );
      CREATE TABLE IF NOT EXISTS record (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL REFERENCES sync_group(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        rid TEXT NOT NULL,
        hlc TEXT NOT NULL,
        deleted INTEGER NOT NULL,
        payload TEXT NOT NULL,
        UNIQUE (group_id, type, rid)
      );
      CREATE INDEX IF NOT EXISTS record_group_seq ON record (group_id, seq);
    `)
  }

  close(): void {
    this.db.close()
  }

  groupCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM sync_group').get() as { n: number }).n
  }

  /** Makes a group with its first device. False if the id is taken. */
  createGroup(id: string, joinHash: string, device: Omit<DeviceRow, 'createdAt' | 'lastSeen'>, now: number): boolean {
    this.db.exec('BEGIN')
    try {
      if (this.db.prepare('SELECT 1 FROM sync_group WHERE id = ?').get(id)) {
        this.db.exec('ROLLBACK')
        return false
      }
      this.db.prepare('INSERT INTO sync_group (id, join_hash, created_at) VALUES (?, ?, ?)').run(id, joinHash, now)
      this.db.prepare('INSERT INTO device (group_id, id, public_key, name, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)').run(id, device.id, device.publicKey, device.name, now, now)
      this.db.exec('COMMIT')
      return true
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  joinHash(groupId: string): string | null {
    const row = this.db.prepare('SELECT join_hash AS h FROM sync_group WHERE id = ?').get(groupId) as { h: string } | undefined
    return row?.h ?? null
  }

  /** Adds a device. 'full' at the device limit, 'taken' if the id is in use with a different key. Joining twice with the same key is fine. */
  addDevice(groupId: string, device: Omit<DeviceRow, 'createdAt' | 'lastSeen'>, now: number): 'added' | 'full' | 'taken' {
    const have = this.device(groupId, device.id)
    if (have) return have.publicKey === device.publicKey ? 'added' : 'taken'
    const n = (this.db.prepare('SELECT COUNT(*) AS n FROM device WHERE group_id = ?').get(groupId) as { n: number }).n
    if (n >= MAX_DEVICES_PER_GROUP) return 'full'
    this.db.prepare('INSERT INTO device (group_id, id, public_key, name, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)').run(groupId, device.id, device.publicKey, device.name, now, now)
    return 'added'
  }

  device(groupId: string, id: string): DeviceRow | null {
    const r = this.db.prepare('SELECT id, public_key AS publicKey, name, created_at AS createdAt, last_seen AS lastSeen FROM device WHERE group_id = ? AND id = ?').get(groupId, id)
    return (r as DeviceRow | undefined) ?? null
  }

  devices(groupId: string): DeviceRow[] {
    return this.db
      .prepare('SELECT id, public_key AS publicKey, name, created_at AS createdAt, last_seen AS lastSeen FROM device WHERE group_id = ? ORDER BY created_at, id')
      .all(groupId) as unknown as DeviceRow[]
  }

  touch(groupId: string, id: string, now: number): void {
    this.db.prepare('UPDATE device SET last_seen = ? WHERE group_id = ? AND id = ?').run(now, groupId, id)
  }

  /** Removes a device. When it was the last one, the group and everything in it goes too. */
  removeDevice(groupId: string, id: string): boolean {
    const r = this.db.prepare('DELETE FROM device WHERE group_id = ? AND id = ?').run(groupId, id)
    if (Number(r.changes) === 0) return false
    if (this.devices(groupId).length === 0) this.db.prepare('DELETE FROM sync_group WHERE id = ?').run(groupId)
    return true
  }

  recordCount(groupId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM record WHERE group_id = ?').get(groupId) as { n: number }).n
  }

  /**
   * Forgets deletion records older than `maxAgeMs`. Every device that syncs at least that often has seen them by now;
   * one that was off for longer could bring a deleted item back, so keep this long. Returns how many were removed.
   */
  pruneDeleted(now: number, maxAgeMs: number): number {
    // A stamp starts with its time as 15 digits, so older stamps sort before this cut-off.
    const cutoff = String(Math.max(0, now - maxAgeMs)).padStart(15, '0')
    return Number(this.db.prepare('DELETE FROM record WHERE deleted = 1 AND hlc < ?').run(cutoff).changes)
  }

  /**
   * Stores records that are newer than what the group has. A record that replaces an older one takes
   * a new, higher sequence number, so every device that already pulled the old one sees the change.
   * Returns how many were stored and how many were turned away because the group is full.
   */
  push(groupId: string, records: SyncRecord[]): { stored: number; refused: number } {
    let stored = 0
    let refused = 0
    this.db.exec('BEGIN')
    try {
      let count = this.recordCount(groupId)
      const find = this.db.prepare('SELECT hlc FROM record WHERE group_id = ? AND type = ? AND rid = ?')
      const put = this.db.prepare('INSERT OR REPLACE INTO record (group_id, type, rid, hlc, deleted, payload) VALUES (?, ?, ?, ?, ?, ?)')
      for (const r of records) {
        const have = find.get(groupId, r.type, r.id) as { hlc: string } | undefined
        if (have && !(r.hlc > have.hlc)) continue
        if (!have && count >= MAX_RECORDS_PER_GROUP) {
          refused++
          continue
        }
        put.run(groupId, r.type, r.id, r.hlc, r.deleted ? 1 : 0, r.payload)
        if (!have) count++
        stored++
      }
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    return { stored, refused }
  }

  /** Records after `since`, oldest first, at most `limit`. `more` says there are further ones. */
  pull(groupId: string, since: number, limit: number): { records: StoredRecord[]; seq: number; more: boolean } {
    const rows = this.db
      .prepare('SELECT seq, type, rid, hlc, deleted, payload FROM record WHERE group_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(groupId, since, limit + 1) as unknown as RecordRow[]
    const page = rows.slice(0, limit)
    const records = page
      .filter((r) => isHlc(r.hlc))
      .map((r) => ({ seq: r.seq, type: r.type as SyncType, id: r.rid, hlc: r.hlc, deleted: r.deleted === 1, payload: r.payload }))
    return { records, seq: page.length > 0 ? page[page.length - 1]!.seq : since, more: rows.length > limit }
  }
}
