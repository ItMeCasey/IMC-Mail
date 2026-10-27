import * as BackgroundTask from 'expo-background-task'
import * as TaskManager from 'expo-task-manager'
import { newMailToNotify } from '@imc/mail'
import { loadAccounts } from './auth'
import { cache, settings } from './db'
import { flushOutbox, folderKey, refreshFolder, savedMessages } from './mail'
import { mailAllowed, notifyNewMail, rescheduleReminders } from './notify'
import { syncNow } from './phonesync'

// Android runs this now and then (at best every 15 minutes, and less when the battery is low) even while the app is
// closed: it syncs with your other devices, checks each account's inbox for new mail, sends anything waiting in the
// outbox, and keeps meeting reminders up to date.

const TASK = 'imc-background-check'

TaskManager.defineTask(TASK, async () => {
  try {
    await syncNow()
    const accounts = await loadAccounts()
    await flushOutbox(accounts).catch(() => 0)
    if (settings.get().checkMailInBackground) {
      const found = []
      for (const account of accounts) {
        const inbox = { path: 'INBOX', name: 'Inbox', delimiter: null, flags: [], specialUse: 'inbox' as const, selectable: true }
        try {
          const before = (await cache.folderState(account.email, folderKey(inbox))) ? await savedMessages(account, inbox) : null
          await refreshFolder(account, inbox)
          found.push(...newMailToNotify(before, await savedMessages(account, inbox), { now: Date.now(), allowed: mailAllowed() }))
        } catch {
          // One account being unreachable should not stop the others.
        }
      }
      await notifyNewMail(found)
    }
    await rescheduleReminders()
    return BackgroundTask.BackgroundTaskResult.Success
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed
  }
})

/** Asks Android to run the check from time to time. Safe to call at every start. */
export async function scheduleBackgroundCheck(): Promise<void> {
  try {
    if (!(await TaskManager.isTaskRegisteredAsync(TASK))) await BackgroundTask.registerTaskAsync(TASK, { minimumInterval: 15 })
  } catch {
    // Not available (for example in a simulator); the app still checks while it is open.
  }
}
