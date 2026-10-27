import { newMailToNotify, type Folder, type Summary } from '@imc/mail'
import type { PhoneAccount } from './auth'
import { cache } from './db'
import { folderKey, refreshFolder, savedMessages } from './mail'
import { mailAllowed } from './notify'

/** The inbox as the app sees it before the server has been asked (its real name is learned from the folder list). */
export const INBOX: Folder = { path: 'INBOX', name: 'Inbox', delimiter: null, flags: [], specialUse: 'inbox', selectable: true }

/**
 * Brings an account's saved inbox up to date and returns the messages worth a notification: new since the last look,
 * unread, recent, and of a kind the person wants to hear about. The first look at an inbox reports nothing.
 */
export async function checkInbox(account: PhoneAccount): Promise<Summary[]> {
  const known = (await cache.folderState(account.email, folderKey(INBOX))) !== null
  const before = known ? await savedMessages(account, INBOX) : null
  await refreshFolder(account, INBOX)
  return newMailToNotify(before, await savedMessages(account, INBOX), { now: Date.now(), allowed: mailAllowed() })
}
