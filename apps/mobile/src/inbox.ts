import { oauthProviders } from '@imc/core'
import { ImapClient, type Summary } from '@imc/mail'
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
