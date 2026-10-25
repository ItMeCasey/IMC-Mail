import { ImapFlow, type FetchMessageObject } from 'imapflow'
import type { FolderRole, ServerConfig } from '@imc/core'
import type { AccountRow, FetchedMessage, MailStore } from '../store'
import type { Credential, Credentials } from '../credentials'
import { parseMessageIds } from '../threading'

/** Newest messages cached per folder. Older mail is backfilled on demand (later phase). */
export const WINDOW = 200
const SAFETY_SYNC_MS = 5 * 60_000
const DEBOUNCE_MS = 300
const MAX_BACKOFF_MS = 5 * 60_000

const SPECIAL_USE: Record<string, FolderRole> = {
  '\\Inbox': 'inbox',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Trash': 'trash',
  '\\Junk': 'junk',
  '\\Archive': 'archive',
  '\\All': 'all',
  '\\Flagged': 'starred'
}

export function roleFor(path: string, specialUse?: string): FolderRole | null {
  if (path.toUpperCase() === 'INBOX') return 'inbox'
  return (specialUse && SPECIAL_USE[specialUse]) || null
}

export function folderName(path: string, delimiter: string | undefined): string {
  if (path.toUpperCase() === 'INBOX') return 'Inbox'
  const parts = delimiter ? path.split(delimiter) : [path]
  return parts[parts.length - 1] || path
}

const toMs = (d: Date | string | undefined): number => {
  if (!d) return 0
  const t = new Date(d).getTime()
  return Number.isNaN(t) ? 0 : t
}

export function toFetched(msg: FetchMessageObject): FetchedMessage {
  const env = msg.envelope
  const from = env?.from?.[0]
  return {
    uid: msg.uid,
    messageId: env?.messageId ?? null,
    fromName: from?.name ?? '',
    fromAddr: from?.address ?? '',
    to: (env?.to ?? [])
      .map((a) => a.address)
      .filter(Boolean)
      .join(', '),
    subject: env?.subject ?? '',
    date: toMs(env?.date) || toMs(msg.internalDate),
    flags: [...(msg.flags ?? [])],
    refs: [
      ...new Set([
        ...parseMessageIds(env?.inReplyTo ?? ''),
        ...parseMessageIds(msg.headers?.toString('latin1') ?? '')
      ])
    ]
  }
}

export function createClient(imap: ServerConfig, user: string, cred: Credential): ImapFlow {
  return new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: imap.security === 'tls',
    // starttls: require the upgrade so credentials never cross in cleartext.
    doSTARTTLS: imap.security === 'starttls' ? true : imap.security === 'none' ? false : undefined,
    auth: { user, ...cred },
    logger: false
  })
}

export function describeError(e: unknown, server?: ServerConfig): string {
  const err = e as { authenticationFailed?: boolean; responseText?: string; code?: string }
  const msg = e instanceof Error ? e.message : String(e)
  if (err.authenticationFailed) {
    return err.responseText ? `Sign-in rejected: ${err.responseText}` : 'Sign-in rejected'
  }
  if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
    return server ? `Cannot reach ${server.host}:${server.port}` : msg
  }
  return msg
}

export async function testConnection(
  imap: ServerConfig,
  user: string,
  pass: string
): Promise<{ ok: true; folders: number } | { ok: false; error: string }> {
  const client = createClient(imap, user, { pass })
  client.on('error', () => {})
  try {
    await client.connect()
    const folders = await client.list()
    return { ok: true, folders: folders.length }
  } catch (e) {
    return { ok: false, error: describeError(e, imap) }
  } finally {
    await client.logout().catch(() => client.close())
  }
}

interface FolderRef {
  id: string
  path: string
}

/**
 * Keeps one account's cache in sync: full pass on connect, IMAP IDLE on the inbox afterwards,
 * a safety re-sync every few minutes, and exponential backoff on connection loss.
 */
export class AccountSync {
  private stopped = false
  private client: ImapFlow | null = null
  private folders: FolderRef[] = []
  private dirty = new Set<string>()
  private pump: Promise<void> | null = null
  private debounce: NodeJS.Timeout | null = null
  private wake: (() => void) | null = null

  constructor(
    private account: AccountRow,
    private store: MailStore,
    private credentials: Credentials,
    private onChange: (accountId: string) => void,
    private onNewMail: (ids: string[]) => void = () => {}
  ) {}

  start(): void {
    void this.run()
  }

  stop(): void {
    this.stopped = true
    if (this.debounce) clearTimeout(this.debounce)
    this.wake?.()
    this.client?.close()
  }

  /** Forces an immediate full sync, reconnecting first if the connection is down. */
  resync(): void {
    if (this.client?.usable) this.schedule('*')
    else this.wake?.()
  }

  /** Progress notes for diagnosing a stuck sync. Off unless IMC_DEBUG_SYNC is set; never includes tokens or mail. */
  private trace(note: string): void {
    if (process.env['IMC_DEBUG_SYNC']) console.log(`[sync ${this.account.email}] ${new Date().toISOString().slice(11, 19)} ${note}`)
  }

  private setState(state: 'connecting' | 'syncing' | 'idle' | 'error', error: string | null = null) {
    this.store.setState(this.account.id, state, error)
    this.onChange(this.account.id)
  }

  private async run(): Promise<void> {
    let attempt = 0
    while (!this.stopped) {
      try {
        await this.session(() => (attempt = 0))
      } catch (e) {
        if (this.stopped) return
        this.setState('error', describeError(e, this.account.config.imap))
      }
      if (this.stopped) return
      const delay = Math.min(MAX_BACKOFF_MS, 2000 * 2 ** attempt++)
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, delay)
        this.wake = () => {
          clearTimeout(t)
          attempt = 0
          resolve()
        }
      })
      this.wake = null
    }
  }

  private async session(onConnected: () => void): Promise<void> {
    const { config, id } = this.account
    this.setState('connecting')
    this.trace('getting credentials')
    // Fetched per connection, so a reconnect always starts with a fresh OAuth access token.
    const client = createClient(config.imap, config.username, await this.credentials.get(this.account))
    this.trace('credentials ready; connecting')
    this.client = client
    client.on('error', (e: Error) => this.trace(`client error: ${describeError(e)}`)) // surfaced through 'close' and the failing call
    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()))

    let timer: NodeJS.Timeout | undefined
    try {
      await client.connect()
      this.trace('connected')
      onConnected()

      client.on('exists', (e: { path: string }) => this.schedule(e.path))
      client.on('expunge', (e: { path: string }) => this.schedule(e.path))
      client.on('flags', (e: { path: string }) => this.schedule(e.path))

      this.dirty.add('*')
      await this.drain()

      timer = setInterval(() => this.schedule('*'), SAFETY_SYNC_MS)
      await closed
    } finally {
      clearInterval(timer)
      client.close()
      this.client = null
    }
    if (!this.stopped) throw new Error('Connection lost')
  }

  /**
   * Downloads one message's raw source on demand. Needs a live connection; cached bodies keep
   * working offline because callers read the cache first.
   */
  async fetchSource(
    path: string,
    uid: number,
    maxBytes: number
  ): Promise<{ source: Buffer; truncated: boolean }> {
    const client = this.client
    if (!client?.usable) throw new Error('Offline: this message has not been downloaded yet')
    const lock = await client.getMailboxLock(path)
    try {
      const dl = await client.download(String(uid), undefined, { uid: true, maxBytes })
      if (!dl || !('content' in dl) || !dl.content) throw new Error('The server no longer has this message')
      const chunks: Buffer[] = []
      let total = 0
      for await (const c of dl.content) {
        const b = Buffer.isBuffer(c) ? c : Buffer.from(c)
        chunks.push(b)
        total += b.length
      }
      return { source: Buffer.concat(chunks), truncated: total >= maxBytes }
    } finally {
      lock.release()
    }
  }

  /** Moves one message to another folder (IMAP MOVE, or copy and delete where unsupported). */
  async moveMessage(path: string, uid: number, dest: string): Promise<void> {
    const client = this.client
    if (!client?.usable) throw new Error('Offline: reconnect to move this message')
    const lock = await client.getMailboxLock(path)
    try {
      await client.messageMove(String(uid), dest, { uid: true })
    } finally {
      lock.release()
    }
  }

  /** Finds a message by its Message-ID header in one folder and moves it to another (used to undo a move). */
  async moveByMessageId(path: string, rfcMessageId: string, dest: string): Promise<void> {
    const client = this.client
    if (!client?.usable) throw new Error('Offline: reconnect to undo this')
    const lock = await client.getMailboxLock(path)
    try {
      const uids = await client.search({ header: { 'message-id': rfcMessageId } }, { uid: true })
      if (!uids || uids.length === 0) throw new Error('The message is not in that folder any more')
      await client.messageMove(uids, dest, { uid: true })
    } finally {
      lock.release()
    }
  }

  /** Creates a folder, top level or inside `parentPath`, using the server's own separator. Returns its path. */
  async createFolder(parentPath: string | null, name: string): Promise<string> {
    const client = this.client
    if (!client?.usable) throw new Error('Offline: reconnect to create a folder')
    const listed = await client.list()
    const delimiter = (parentPath ? listed.find((b) => b.path === parentPath)?.delimiter : listed[0]?.delimiter) ?? '/'
    const path = parentPath ? `${parentPath}${delimiter}${name}` : name
    await client.mailboxCreate(path)
    this.schedule('*')
    return path
  }

  /** Renames a folder (and, on the server, the folders inside it). */
  async renameFolder(path: string, newPath: string): Promise<void> {
    const client = this.client
    if (!client?.usable) throw new Error('Offline: reconnect to rename a folder')
    await client.mailboxRename(path, newPath)
    this.schedule('*')
  }

  /** Deletes a folder and everything in it from the server. */
  async deleteFolder(path: string): Promise<void> {
    const client = this.client
    if (!client?.usable) throw new Error('Offline: reconnect to delete a folder')
    await client.mailboxDelete(path)
    this.schedule('*')
  }

  /** Sets or clears the Seen flag on every message in a folder, including ones this app has not downloaded. */
  async markAllSeen(path: string, seen: boolean): Promise<void> {
    const client = this.client
    if (!client?.usable) throw new Error('Offline: reconnect to change these messages')
    const lock = await client.getMailboxLock(path)
    try {
      if (!client.mailbox || client.mailbox.exists === 0) return
      if (seen) await client.messageFlagsAdd('1:*', ['\\Seen'])
      else await client.messageFlagsRemove('1:*', ['\\Seen'])
    } finally {
      lock.release()
    }
  }

  /** Permanently removes one message from the server. */
  async deleteMessage(path: string, uid: number): Promise<void> {
    const client = this.client
    if (!client?.usable) throw new Error('Offline: reconnect to delete this message')
    const lock = await client.getMailboxLock(path)
    try {
      await client.messageDelete(String(uid), { uid: true })
    } finally {
      lock.release()
    }
  }

  /** Files a copy of a sent message into a folder, marked as read. */
  async append(path: string, raw: Buffer): Promise<void> {
    const client = this.client
    if (!client?.usable) throw new Error('Offline: could not copy the message to Sent')
    await client.append(path, raw, ['\\Seen'])
  }

  /** Adds and removes IMAP flags on one message. */
  async setFlags(
    path: string,
    uid: number,
    change: { add?: string[]; remove?: string[] }
  ): Promise<void> {
    const client = this.client
    if (!client?.usable) throw new Error('Offline: reconnect to change this message')
    const lock = await client.getMailboxLock(path)
    try {
      if (change.add?.length) await client.messageFlagsAdd(String(uid), change.add, { uid: true })
      if (change.remove?.length) {
        await client.messageFlagsRemove(String(uid), change.remove, { uid: true })
      }
    } finally {
      lock.release()
    }
  }

  private schedule(path: string): void {
    this.dirty.add(path)
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      this.pump ??= this.drain()
        .catch((e) => this.setState('error', describeError(e, this.account.config.imap)))
        .finally(() => (this.pump = null))
    }, DEBOUNCE_MS)
  }

  private async drain(): Promise<void> {
    const client = this.client
    if (!client?.usable) return
    this.setState('syncing')
    while (this.dirty.size > 0) {
      const batch = [...this.dirty]
      this.dirty.clear()
      if (batch.includes('*')) await this.syncAll(client)
      else {
        for (const path of batch) {
          const f = this.folders.find((x) => x.path === path)
          if (f) await this.syncFolder(client, f)
        }
      }
    }
    // Park on the inbox so IMAP IDLE keeps watching it.
    if (client.usable && (client.mailbox ? client.mailbox.path : null) !== 'INBOX') {
      await client.mailboxOpen('INBOX')
    }
    this.setState('idle')
  }

  private async syncAll(client: ImapFlow): Promise<void> {
    this.trace('listing folders')
    const listed = await client.list()
    this.trace(`${listed.length} folders`)
    const selectable = listed.filter(
      (b) => !b.flags.has('\\Noselect') && !b.flags.has('\\NonExistent')
    )
    this.folders = selectable.map((b) => ({
      id: this.store.upsertFolder(this.account.id, {
        path: b.path,
        name: folderName(b.path, b.delimiter),
        role: roleFor(b.path, b.specialUse)
      }),
      path: b.path
    }))
    this.store.pruneFolders(
      this.account.id,
      this.folders.map((f) => f.path)
    )
    this.onChange(this.account.id)

    const inboxFirst = [...this.folders].sort(
      (a, b) => Number(b.path === 'INBOX') - Number(a.path === 'INBOX')
    )
    for (const f of inboxFirst) {
      if (!client.usable || this.stopped) return
      try {
        await this.syncFolder(client, f)
      } catch (e) {
        // One bad folder must not stop the rest; connection loss surfaces via 'close'.
        if (!client.usable) throw e
        console.error(`[sync ${this.account.email}] ${f.path}:`, describeError(e))
      }
    }
  }

  /** Fetches the `count` messages just older than the oldest one cached. Returns how many, and whether older ones remain. */
  async loadOlder(folder: FolderRef, count = WINDOW): Promise<{ loaded: number; more: boolean }> {
    const client = this.client
    if (!client?.usable) throw new Error('Offline: reconnect to load older mail')
    const lock = await client.getMailboxLock(folder.path)
    try {
      const oldest = this.store.oldestUid(folder.id)
      if (oldest === null) return { loaded: 0, more: false }
      const uids = (await client.search({ uid: `1:${oldest - 1}` }, { uid: true })) || []
      if (uids.length === 0) return { loaded: 0, more: false }
      const batch = uids.slice(-count)
      const fetched: FetchedMessage[] = []
      const query = { uid: true, flags: true, envelope: true, internalDate: true, headers: ['references', 'in-reply-to'] }
      for await (const m of client.fetch(`${batch[0]}:${batch[batch.length - 1]}`, query, { uid: true })) {
        fetched.push(toFetched(m))
      }
      // No deletion pass: older mail is only ever added here.
      this.store.applyFetched(this.account.id, folder.id, fetched, null)
      this.store.rethread(this.account.id)
      this.onChange(this.account.id)
      return { loaded: fetched.length, more: uids.length > batch.length }
    } finally {
      lock.release()
    }
  }

  private async syncFolder(client: ImapFlow, folder: FolderRef): Promise<void> {
    this.trace(`syncing ${folder.path}`)
    const lock = await client.getMailboxLock(folder.path)
    this.trace(`opened ${folder.path} (${client.mailbox ? client.mailbox.exists : '?'} messages)`)
    try {
      const mb = client.mailbox
      if (!mb) return

      const uidValidity = Number(mb.uidValidity)
      const prev = this.store.getFolderSyncState(folder.id).uidValidity
      if (prev !== null && prev !== uidValidity) this.store.clearFolder(folder.id)
      this.store.setUidValidity(folder.id, uidValidity)

      const fetched: FetchedMessage[] = []
      const query = {
        uid: true,
        flags: true,
        envelope: true,
        internalDate: true,
        headers: ['references', 'in-reply-to']
      }
      let deleteFrom: number | null = null
      // The very first pass over a folder is catch-up, not news.
      const hadMail = this.store.windowStartUid(folder.id, 1) !== null

      if (mb.exists === 0) {
        this.store.applyFetched(this.account.id, folder.id, [], 0)
      } else {
        const startUid = this.store.windowStartUid(folder.id, WINDOW)
        if (startUid === null) {
          const first = Math.max(1, mb.exists - WINDOW + 1)
          for await (const m of client.fetch(`${first}:*`, query)) fetched.push(toFetched(m))
        } else {
          deleteFrom = startUid
          for await (const m of client.fetch(`${startUid}:*`, query, { uid: true })) {
            fetched.push(toFetched(m))
          }
        }
        const fresh = this.store.applyFetched(this.account.id, folder.id, fetched, deleteFrom)
        if (hadMail && fresh.length > 0) this.onNewMail(fresh)
      }
      this.store.rethread(this.account.id)
    } finally {
      lock.release()
    }
    this.onChange(this.account.id)
  }
}
