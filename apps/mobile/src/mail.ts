import { File, Paths } from 'expo-file-system'
import {
  applyAction,
  buildMessage,
  extractAttachment,
  folderFor,
  ImapClient,
  parseMessage,
  Pop3Client,
  recipientsOf,
  SmtpClient,
  SmtpError,
  syncFolder,
  syncPop3,
  type Folder,
  type MessageAction,
  type Outgoing,
  type ParsedMessage,
  type SyncResult,
  type Summary
} from '@imc/mail'
import { credentials, serversOf, type PhoneAccount } from './auth'
import { bodies, cache, folders as folderCache, queue } from './db'
import { tell } from './report'
import { tcpConnect } from './tcp'

// Everything the phone does with a mail account: connect, list and save folders, read, act on, send and download.
// Google and Microsoft accounts sign in with a token, other accounts with a password; IMAP accounts have folders,
// POP3 accounts have an inbox only.

/** One connection at a time per account: servers limit how many a person may open, and it keeps the saved copy tidy. */
const lanes = new Map<string, Promise<unknown>>()
function inLane<T>(account: PhoneAccount, job: () => Promise<T>): Promise<T> {
  const run = (lanes.get(account.email) ?? Promise.resolve()).then(job, job)
  lanes.set(
    account.email,
    run.catch(() => undefined)
  )
  return run
}

const isPop3 = (a: PhoneAccount) => a.protocol === 'pop3'

/** The inbox of a POP3 account, as the folder list shows it. */
const POP3_INBOX: Folder = { path: 'INBOX', name: 'Inbox', delimiter: null, flags: [], specialUse: 'inbox', selectable: true }

/** A folder is saved under its path, except the inbox, which is always "inbox" (the server may call it INBOX or Inbox). */
export const folderKey = (f: Folder): string => (f.specialUse === 'inbox' ? 'inbox' : f.path)

async function openImap(account: PhoneAccount): Promise<ImapClient> {
  const { incoming } = serversOf(account)
  const client = new ImapClient(tcpConnect, { host: incoming.host, port: incoming.port, security: incoming.security })
  await client.open()
  const c = await credentials(account)
  if (c.kind === 'oauth') await client.authXoauth2(c.user, c.token)
  else await client.login(c.user, c.password)
  return client
}

async function openPop3(account: PhoneAccount): Promise<Pop3Client> {
  const { incoming } = serversOf(account)
  const client = new Pop3Client(tcpConnect, { host: incoming.host, port: incoming.port, security: incoming.security })
  await client.open()
  const c = await credentials(account)
  if (c.kind !== 'password') throw new Error('POP3 needs a password account')
  await client.login(c.user, c.password)
  return client
}

/** Runs something on a signed-in IMAP connection, and signs out afterwards. */
export function withImap<T>(account: PhoneAccount, fn: (c: ImapClient) => Promise<T>): Promise<T> {
  return inLane(account, async () => {
    const client = await openImap(account)
    try {
      return await fn(client)
    } finally {
      await client.logout()
    }
  })
}

function withPop3<T>(account: PhoneAccount, fn: (c: Pop3Client) => Promise<T>): Promise<T> {
  return inLane(account, async () => {
    const client = await openPop3(account)
    try {
      return await fn(client)
    } finally {
      await client.quit()
    }
  })
}

// ---- folders and saved lists ---------------------------------------------------------------------------------

/** The folders saved for the account (instant). A POP3 account has only its inbox. */
export function savedFolders(account: PhoneAccount): Folder[] {
  if (isPop3(account)) return [POP3_INBOX]
  const saved = folderCache.get(account.email)
  return saved.length > 0 ? saved : [{ ...POP3_INBOX, path: 'INBOX' }]
}

/** Asks the server for the folder list and saves it. */
export async function refreshFolders(account: PhoneAccount): Promise<Folder[]> {
  if (isPop3(account)) return [POP3_INBOX]
  const list = await withImap(account, (c) => c.list())
  folderCache.set(account.email, list)
  return list
}

export const savedMessages = (account: PhoneAccount, folder: Folder): Promise<Summary[]> => cache.summaries(account.email, folderKey(folder))

export async function lastSynced(account: PhoneAccount, folder: Folder): Promise<number | null> {
  return (await cache.folderState(account.email, folderKey(folder)))?.syncedAt ?? null
}

/** Brings a folder's saved list up to date: new mail, deletions, read and starred marks. */
export function refreshFolder(account: PhoneAccount, folder: Folder): Promise<SyncResult> {
  if (isPop3(account)) return withPop3(account, (c) => syncPop3(c, cache, account.email, folderKey(folder)))
  return withImap(account, (c) => syncFolder(c, cache, account.email, folder.path, { cacheKey: folderKey(folder) }))
}

// ---- reading ----------------------------------------------------------------------------------------------------

/** Most of a message to download: a very large attachment is cut off, and the text before it still reads fine. */
const MAX_MESSAGE_BYTES = 3_000_000

export interface OpenedMessage {
  message: Pick<ParsedMessage, 'text' | 'html' | 'attachments'>
  truncated: boolean
  fromCache: boolean
  rawBytes: number
}

const toBytes = (raw: Uint8Array): Uint8Array => raw

/** A message to read: the saved copy if there is one, otherwise it is downloaded (and saved). Opening it marks it read. */
export async function readMessage(account: PhoneAccount, folder: Folder, summary: Summary): Promise<OpenedMessage> {
  const key = folderKey(folder)
  const saved = bodies.get(account.email, key, summary.uid)
  if (saved) {
    void markRead(account, folder, summary).catch(() => undefined) // best effort; offline is fine
    return { message: saved, truncated: saved.truncated, fromCache: true, rawBytes: 0 }
  }
  const raw = toBytes(await downloadRaw(account, folder, summary, MAX_MESSAGE_BYTES))
  const message = await parseMessage(raw)
  const truncated = raw.length >= MAX_MESSAGE_BYTES
  bodies.put(account.email, key, summary.uid, { text: message.text, html: message.html, attachments: message.attachments, truncated })
  await markRead(account, folder, summary).catch(() => undefined)
  return { message, truncated, fromCache: false, rawBytes: raw.length }
}

function downloadRaw(account: PhoneAccount, folder: Folder, summary: Summary, maxBytes?: number): Promise<Uint8Array> {
  if (isPop3(account)) {
    return withPop3(account, async (c) => {
      const n = (await c.uidl()).find((m) => m.id === summary.remoteId)?.n
      if (!n) throw new Error('This message is not on the server any more')
      return c.retr(n)
    })
  }
  return withImap(account, async (c) => {
    await c.select(folder.path, false)
    return c.fetchRaw(summary.uid, maxBytes)
  })
}

/** Marks a message read in the saved copy, and on the server for IMAP. */
async function markRead(account: PhoneAccount, folder: Folder, summary: Summary): Promise<void> {
  const key = folderKey(folder)
  const mine = (await cache.summaries(account.email, key)).find((m) => m.uid === summary.uid)
  if (mine && !mine.flags.includes('\\Seen')) await cache.setFlags(account.email, key, new Map([[summary.uid, [...mine.flags, '\\Seen']]]))
  if (!isPop3(account) && !summary.flags.includes('\\Seen')) await withImap(account, async (c) => (await c.select(folder.path, false), c.setFlags([summary.uid], { add: ['\\Seen'] })))
}

// ---- acting on messages --------------------------------------------------------------------------------------------

/**
 * Archives, trashes, deletes or marks messages. The saved list is changed at once; if the server cannot be reached the
 * change is undone and the error is shown.
 */
export async function actOn(account: PhoneAccount, folder: Folder, summaries: Summary[], action: MessageAction): Promise<void> {
  const key = folderKey(folder)
  const uids = summaries.map((m) => m.uid)
  if (isPop3(account)) {
    if (action === 'trash' || action === 'delete' || action === 'archive' || action === 'junk') {
      await withPop3(account, async (c) => {
        const listed = await c.uidl()
        for (const m of summaries) {
          const n = listed.find((x) => x.id === m.remoteId)?.n
          if (n) await c.dele(n)
        }
      })
      await cache.remove(account.email, key, uids)
      return
    }
    await changeFlagsHere(account, key, summaries, action)
    return
  }
  const known = savedFolders(account)
  const { left } = await withImap(account, (c) => applyAction(c, known, folder.path, uids, action))
  if (left) await cache.remove(account.email, key, uids)
  else await changeFlagsHere(account, key, summaries, action)
}

async function changeFlagsHere(account: PhoneAccount, key: string, summaries: Summary[], action: MessageAction): Promise<void> {
  const flag = action === 'markRead' || action === 'markUnread' ? '\\Seen' : action === 'star' || action === 'unstar' ? '\\Flagged' : null
  if (!flag) return
  const add = action === 'markRead' || action === 'star'
  const next = new Map(summaries.map((m) => [m.uid, add ? [...new Set([...m.flags, flag])] : m.flags.filter((f) => f !== flag)]))
  await cache.setFlags(account.email, key, next)
}

// ---- sending ---------------------------------------------------------------------------------------------------------

export type SendResult = 'sent' | 'queued'

async function deliver(account: PhoneAccount, sender: string, recipients: string[], raw: Uint8Array): Promise<void> {
  const { outgoing } = serversOf(account)
  const client = new SmtpClient(tcpConnect, { host: outgoing.host, port: outgoing.port, security: outgoing.security })
  await client.open()
  try {
    const c = await credentials(account)
    if (c.kind === 'oauth') await client.authXoauth2(c.user, c.token)
    else await client.authPlain(c.user, c.password)
    await client.send(sender, recipients, raw)
  } finally {
    await client.quit()
  }
}

/** A failure of the connection (worth retrying later), as opposed to the server refusing the message or the sign-in. */
const isNetworkFailure = (e: unknown): boolean => (e instanceof SmtpError ? e.kind === 'closed' || e.kind === 'timeout' : e instanceof TypeError || (e instanceof Error && /network|connect|socket|timed? ?out|refused|unreachable|reset/i.test(e.message)))

/** Sends a message. If there is no connection it waits in the outbox (and goes when `flushOutbox` runs). */
export async function sendMail(account: PhoneAccount, message: Omit<Outgoing, 'from'>): Promise<SendResult> {
  const from = { name: account.name, address: account.email }
  const { raw, messageId } = buildMessage({ ...message, from })
  const recipients = recipientsOf(message)
  try {
    await deliver(account, account.email, recipients, raw)
    void tell({ send: account.provider, outcome: 'accepted', recipients: recipients.length })
  } catch (e) {
    void tell({ send: account.provider, outcome: 'failed', message: e instanceof Error ? e.message : String(e) })
    if (!isNetworkFailure(e)) throw e
    queue.add({ id: messageId, account: account.email, sender: account.email, recipients, raw, subject: message.subject, createdAt: Date.now() })
    return 'queued'
  }
  await saveSentCopy(account, raw).catch(() => undefined)
  return 'sent'
}

/** Gmail and Outlook keep a copy of what you send; other servers need us to save it. */
async function saveSentCopy(account: PhoneAccount, raw: Uint8Array): Promise<void> {
  if (account.provider !== 'imap' || isPop3(account)) return
  const sent = folderFor(savedFolders(account), 'sent')
  if (sent) await withImap(account, (c) => c.append(sent.path, raw))
}

/** Tries again to send what is waiting. Returns how many went. */
export async function flushOutbox(accounts: PhoneAccount[]): Promise<number> {
  let sent = 0
  for (const m of queue.list()) {
    const account = accounts.find((a) => a.email === m.account)
    if (!account) {
      queue.remove(m.id)
      continue
    }
    try {
      await deliver(account, m.sender, m.recipients, m.raw)
      await saveSentCopy(account, m.raw).catch(() => undefined)
      queue.remove(m.id)
      sent++
    } catch (e) {
      if (!isNetworkFailure(e)) queue.fail(m.id, e instanceof Error ? e.message : String(e))
    }
  }
  return sent
}

// ---- attachments -----------------------------------------------------------------------------------------------------

/** Downloads one attachment to a file the share sheet can open. Returns where it is. */
export async function saveAttachment(account: PhoneAccount, folder: Folder, summary: Summary, index: number): Promise<{ uri: string; mimeType: string; filename: string }> {
  const raw = await downloadRaw(account, folder, summary)
  const a = await extractAttachment(raw, index)
  if (!a) throw new Error('This attachment is not in the message any more')
  // Only the name is used for the file, never a path the sender chose.
  const safe = a.filename.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(-120) || 'attachment'
  const file = new File(Paths.cache, `${Date.now()}-${safe}`)
  file.create()
  file.write(a.content)
  return { uri: file.uri, mimeType: a.mimeType, filename: safe }
}
