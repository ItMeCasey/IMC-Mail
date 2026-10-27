import type { ImapClient, Summary } from './imap'

// Keeping a local copy of a folder's message list in step with the server, so the inbox opens at once and works
// without a connection. The storage is passed in (a database on the phone, a Map in tests); the rules live here.

export interface FolderState {
  /** A folder whose UIDVALIDITY changes has been rebuilt on the server: every saved uid means something else now. */
  uidValidity: number
  /** The newest message number seen. */
  highestUid: number
  /** When it was last brought up to date, epoch ms. */
  syncedAt: number
}

export interface MailCache {
  folderState(account: string, folder: string): Promise<FolderState | null>
  setFolderState(account: string, folder: string, state: FolderState): Promise<void>
  /** Every saved message of the folder, newest first. */
  summaries(account: string, folder: string): Promise<Summary[]>
  upsert(account: string, folder: string, list: Summary[]): Promise<void>
  setFlags(account: string, folder: string, flags: Map<number, string[]>): Promise<void>
  remove(account: string, folder: string, uids: number[]): Promise<void>
  /** Forgets everything saved for the folder. */
  clear(account: string, folder: string): Promise<void>
}

export interface SyncResult {
  added: number
  removed: number
  flagsChanged: number
  /** The folder was rebuilt on the server, so what was saved was thrown away first. */
  reset: boolean
}

type Reader = Pick<ImapClient, 'select' | 'searchUids' | 'fetchSummaries' | 'fetchFlags'>

const sameFlags = (a: string[], b: string[]): boolean => a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000')

/** The newest messages kept on the phone for a folder. Older ones are read from the server when asked for. */
export const DEFAULT_WINDOW = 200

/**
 * Brings a folder's saved list up to date: new messages are fetched (the newest `window` of them at first), messages
 * the server no longer has are dropped, and changed flags (read, starred) are updated. The folder must be reachable
 * through `client` (signed in); this selects it.
 */
export async function syncFolder(client: Reader, cache: MailCache, account: string, folder: string, opts: { window?: number; now?: () => number; /** Name the folder is saved under, when it should not be its server path (the inbox is just "inbox"). */ cacheKey?: string } = {}): Promise<SyncResult> {
  const window = opts.window ?? DEFAULT_WINDOW
  const now = opts.now ?? Date.now
  const server = await client.select(folder)
  const key = opts.cacheKey ?? folder
  const before = await cache.folderState(account, key)
  let reset = false
  if (before && before.uidValidity !== server.uidValidity) {
    await cache.clear(account, key)
    reset = true
  }

  const onServer = await client.searchUids()
  const present = new Set(onServer)
  const saved = reset ? [] : await cache.summaries(account, key)
  const have = new Map(saved.map((m) => [m.uid, m]))

  const gone = saved.filter((m) => !present.has(m.uid)).map((m) => m.uid)
  if (gone.length > 0) await cache.remove(account, key, gone)

  // Only the newest `window` are kept up to date; an older message already saved stays as it is.
  const recent = onServer.slice(-window)
  const fresh = recent.filter((u) => !have.has(u))
  const fetched = fresh.length > 0 ? await client.fetchSummaries(fresh) : []
  if (fetched.length > 0) await cache.upsert(account, key, fetched)

  const known = recent.filter((u) => have.has(u))
  const flags = known.length > 0 ? await client.fetchFlags(known) : new Map<number, string[]>()
  const changed = new Map<number, string[]>()
  for (const [uid, f] of flags) if (!sameFlags(f, have.get(uid)?.flags ?? [])) changed.set(uid, f)
  if (changed.size > 0) await cache.setFlags(account, key, changed)

  const all = [...have.keys(), ...fetched.map((m) => m.uid)].filter((u) => present.has(u))
  await cache.setFolderState(account, key, { uidValidity: server.uidValidity, highestUid: Math.max(0, ...all), syncedAt: now() })
  return { added: fetched.length, removed: gone.length, flagsChanged: changed.size, reset }
}

/** A cache held in memory: for tests, and a fallback when no database is available. */
export class MemoryCache implements MailCache {
  private states = new Map<string, FolderState>()
  private messages = new Map<string, Map<number, Summary>>()

  private key = (account: string, folder: string) => `${account}\u0000${folder}`
  private box(account: string, folder: string): Map<number, Summary> {
    const k = this.key(account, folder)
    let m = this.messages.get(k)
    if (!m) this.messages.set(k, (m = new Map()))
    return m
  }

  async folderState(account: string, folder: string) {
    return this.states.get(this.key(account, folder)) ?? null
  }
  async setFolderState(account: string, folder: string, state: FolderState) {
    this.states.set(this.key(account, folder), state)
  }
  async summaries(account: string, folder: string) {
    return [...this.box(account, folder).values()].sort((a, b) => b.uid - a.uid)
  }
  async upsert(account: string, folder: string, list: Summary[]) {
    for (const m of list) this.box(account, folder).set(m.uid, m)
  }
  async setFlags(account: string, folder: string, flags: Map<number, string[]>) {
    const box = this.box(account, folder)
    for (const [uid, f] of flags) {
      const m = box.get(uid)
      if (m) box.set(uid, { ...m, flags: f })
    }
  }
  async remove(account: string, folder: string, uids: number[]) {
    for (const u of uids) this.box(account, folder).delete(u)
  }
  async clear(account: string, folder: string) {
    this.messages.delete(this.key(account, folder))
    this.states.delete(this.key(account, folder))
  }
}
