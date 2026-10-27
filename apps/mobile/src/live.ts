import BackgroundService from 'react-native-background-actions'
import type { ImapClient } from '@imc/mail'
import { loadAccounts, type PhoneAccount } from './auth'
import { notifyChanged } from './changes'
import { checkInbox } from './inbox-check'
import { openImap } from './mail'
import { notifyNewMail } from './notify'
import { tell } from './report'
import { settings } from './db'

// Live mail: while it is on, the phone keeps one connection open to each IMAP account's inbox and asks the server to
// say when something arrives (IMAP IDLE), so new mail shows up in seconds instead of at the next scheduled check. No
// server of ours is involved and no one else sees the mailbox. Android only lets an app do this with a foreground
// service, which shows a notification for as long as it runs; that is why it is a choice and off until you turn it on.

/** How long to wait on one IDLE before asking again (servers drop an idle connection after about half an hour). */
const IDLE_MS = 9 * 60_000
const RETRY_FIRST_MS = 5_000
const RETRY_MAX_MS = 5 * 60_000

let running = false
const waiting = new Set<ImapClient>()

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Keeps watching one account's inbox until live mail is turned off, reconnecting after any failure. */
async function watch(account: PhoneAccount): Promise<void> {
  let retry = RETRY_FIRST_MS
  while (running) {
    let client: ImapClient | null = null
    try {
      client = await openImap(account)
      if (!client.capabilities.has('IDLE')) {
        // No way to wait on this server: leave it to the scheduled check.
        void tell({ live: account.provider, idle: false })
        await client.logout()
        return
      }
      await client.select('INBOX', true)
      waiting.add(client)
      retry = RETRY_FIRST_MS
      while (running) {
        const news = await client.idle(IDLE_MS)
        if (news === 'changed' && running) {
          const found = await checkInbox(account)
          void notifyNewMail(found)
          notifyChanged()
          void tell({ live: account.provider, news: found.length })
          // The refresh used its own connection; this one may have missed changes meanwhile, so look again.
          await client.select('INBOX', true)
        }
      }
    } catch (e) {
      if (!running) return
      void tell({ live: account.provider, retryInMs: retry, message: e instanceof Error ? e.message : String(e) })
      await sleep(retry)
      retry = Math.min(retry * 2, RETRY_MAX_MS)
    } finally {
      if (client) {
        waiting.delete(client)
        void client.logout().catch(() => undefined)
      }
    }
  }
}

/** The work the foreground service runs: one watcher per account, until stopped. */
async function service(): Promise<void> {
  const accounts = (await loadAccounts()).filter((a) => a.protocol !== 'pop3')
  await Promise.all(accounts.map((a) => watch(a)))
  while (running) await sleep(1000)
}

/** Turns live mail on: starts the foreground service. Safe to call when it is already running. */
export async function startLive(): Promise<void> {
  if (running && BackgroundService.isRunning()) return
  running = true
  await BackgroundService.start(service, {
    taskName: 'IMC-Mail live mail',
    taskTitle: 'IMC-Mail is watching for new mail',
    taskDesc: 'Live mail is on. Turn it off in Settings.',
    taskIcon: { name: 'ic_launcher', type: 'mipmap' },
    color: '#7d9fff',
    foregroundServiceType: ['dataSync']
  })
}

/** Turns live mail off: wakes every waiting connection so the service winds down at once. */
export async function stopLive(): Promise<void> {
  running = false
  for (const c of waiting) c.wake()
  if (BackgroundService.isRunning()) await BackgroundService.stop()
}

/** Starts live mail at app start if it was left on. A failure here must not stop the app. */
export async function resumeLive(): Promise<void> {
  if (!settings.get().liveMail) return
  try {
    await startLive()
  } catch (e) {
    void tell({ live: 'start', message: e instanceof Error ? e.message : String(e) })
  }
}
