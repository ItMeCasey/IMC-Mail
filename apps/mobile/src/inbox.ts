import { oauthProviders } from '@imc/core'
import { ImapClient, parseMessage, type ParsedMessage, type Summary } from '@imc/mail'
import { accessToken, type PhoneAccount } from './auth'
import { tcpConnect } from './tcp'

/** Opens a signed-in connection to the account's mail server. */
export async function connect(account: PhoneAccount): Promise<ImapClient> {
  const server = oauthProviders[account.provider].imap
  const client = new ImapClient(tcpConnect, { host: server.host, port: server.port, security: server.security })
  await client.open()
  await client.authXoauth2(account.email, await accessToken(account))
  return client
}

/** The newest messages in the inbox, newest first. Reads headers only. */
export async function newestInbox(account: PhoneAccount, count = 25): Promise<Summary[]> {
  const client = await connect(account)
  try {
    const inbox = (await client.list()).find((f) => f.specialUse === 'inbox')
    if (!inbox) throw new Error('No inbox was found on this account')
    await client.select(inbox.path)
    const uids = await client.searchUids()
    const summaries = await client.fetchSummaries(uids.slice(-count))
    return summaries.sort((a, b) => (b.date ?? 0) - (a.date ?? 0) || b.uid - a.uid)
  } finally {
    await client.logout()
  }
}

/** Most of a message to download: a very large attachment is cut off, and the text before it still reads fine. */
const MAX_MESSAGE_BYTES = 3_000_000

export interface OpenedMessage {
  message: ParsedMessage
  /** The message was longer than what was downloaded. */
  truncated: boolean
  /** How many bytes came down. */
  rawBytes: number
}

/** Downloads one inbox message and reads it. Opening it marks it read, as in any mail app. */
export async function readMessage(account: PhoneAccount, uid: number): Promise<OpenedMessage> {
  const client = await connect(account)
  try {
    const inbox = (await client.list()).find((f) => f.specialUse === 'inbox')
    if (!inbox) throw new Error('No inbox was found on this account')
    await client.select(inbox.path, false)
    const raw = await client.fetchRaw(uid, MAX_MESSAGE_BYTES)
    const message = await parseMessage(raw)
    await client.setFlags([uid], { add: ['\Seen'] }).catch(() => undefined)
    return { message, truncated: raw.length >= MAX_MESSAGE_BYTES, rawBytes: raw.length }
  } finally {
    await client.logout()
  }
}
