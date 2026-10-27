import * as BackgroundTask from 'expo-background-task'
import * as TaskManager from 'expo-task-manager'
import { loadAccounts } from './auth'
import { settings } from './db'
import { checkInbox } from './inbox-check'
import { flushOutbox } from './mail'
import { notifyNewMail, rescheduleReminders } from './notify'
import { syncNow } from './phonesync'
import { tell } from './report'
import type { Summary } from '@imc/mail'

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
      const found: Summary[] = []
      for (const account of accounts) {
        try {
          found.push(...(await checkInbox(account)))
        } catch {
          // One account being unreachable should not stop the others.
        }
      }
      await notifyNewMail(found)
    }
    await rescheduleReminders()
    void tell({ background: 'ok' })
  } catch (e) {
    void tell({ background: 'failed', message: e instanceof Error ? e.message : String(e) })
    void tell({ background: 'failed' })
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
