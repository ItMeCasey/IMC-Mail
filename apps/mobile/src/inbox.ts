import { oauthProviders } from '@imc/core'
import { ImapClient, parseMessage, syncFolder, type ParsedMessage, type SyncResult, type Summary } from '@imc/mail'
import { accessToken, type PhoneAccount } from './auth'
import { cachedBody, saveBody, sqliteCache } from './db'
import { tcpConnect } from './tcp'

/** The inbox is saved under this name whatever the server calls it ("INBOX", "Inbox"). */
const INBOX = 'inbox'

/** Opens a signed-in connection to the account's mail server. */
export async function connect(account: PhoneAccount): Promise<ImapClient> {
  const server = oauthProviders[account.provider].imap
  const client = new ImapClient(tcpConnect, { host: server.host, port: server.port, security: server.security })
  await client.open()
  await client.authXoauth2(account.email, await accessToken(account))
  return client
}

async function inboxPath(client: ImapClient): Promise<string> {
  const inbox = (await client.list()).find((f) => f.specialUse === 'inbox')
  if (!inbox) throw new Error('No inbox was found on this account')
  return inbox.path
}

/** The saved inbox, newest first. Instant, and works without a connection. */
export async function savedInbox(account: PhoneAccount): Promise<Summary[]> {
  return sqliteCache.summaries(account.email, INBOX)
}

/** When the saved inbox was last brought up to date, or null if it never was. */
export async function lastSynced(account: PhoneAccount): Promise<number | null> {
  return (await sqliteCache.folderState(account.email, INBOX))?.syncedAt ?? null
}

/** Brings the saved inbox up to date with the server: new mail, deletions, read and starred marks. */
export async function refreshInbox(account: PhoneAccount): Promise<SyncResult> {
  const client = await connect(account)
  try {
    return await syncFolder(client, sqliteCache, account.email, await inboxPath(client), { cacheKey: INBOX })
  } finally {
    await client.logout()
  }
}

/** Most of a message to download: a very large attachment is cut off, and the text before it still reads fine. */
const MAX_MESSAGE_BYTES = 3_000_000

export interface OpenedMessage {
  message: Pick<ParsedMessage, 'text' | 'html' | 'attachments'>
  /** The message was longer than what was downloaded. */
  truncated: boolean
  /** It came from the phone's saved copy rather than the server. */
  fromCache: boolean
  /** How many bytes came down (0 from the saved copy). */
  rawBytes: number
}

/** A message to read: the saved copy if there is one, otherwise it is downloaded (and saved). Opening it marks it read. */
export async function readMessage(account: PhoneAccount, uid: number): Promise<OpenedMessage> {
  const saved = await cachedBody(account.email, INBOX, uid)
  if (saved) {
    void markRead(account, uid) // best effort; offline is fine
    return { message: saved, truncated: saved.truncated, fromCache: true, rawBytes: 0 }
  }
  const client = await connect(account)
  try {
    await client.select(await inboxPath(client), false)
    const raw = await client.fetchRaw(uid, MAX_MESSAGE_BYTES)
    const message = await parseMessage(raw)
    const truncated = raw.length >= MAX_MESSAGE_BYTES
    await saveBody(account.email, INBOX, uid, { text: message.text, html: message.html, attachments: message.attachments, truncated })
    await client.setFlags([uid], { add: ['\\Seen'] }).catch(() => undefined)
    await markReadHere(account, uid)
    return { message, truncated, fromCache: false, rawBytes: raw.length }
  } finally {
    await client.logout()
  }
}

async function markReadHere(account: PhoneAccount, uid: number): Promise<void> {
  const mine = (await sqliteCache.summaries(account.email, INBOX)).find((m) => m.uid === uid)
  if (mine && !mine.flags.includes('\\Seen')) await sqliteCache.setFlags(account.email, INBOX, new Map([[uid, [...mine.flags, '\\Seen']]]))
}

/** Marks a message read on the server and in the saved copy. Failing (no connection) is fine: the next refresh settles it. */
async function markRead(account: PhoneAccount, uid: number): Promise<void> {
  try {
    await markReadHere(account, uid)
    const client = await connect(account)
    try {
      await client.select(await inboxPath(client), false)
      await client.setFlags([uid], { add: ['\\Seen'] })
    } finally {
      await client.logout()
    }
  } catch {
    // offline
  }
}
