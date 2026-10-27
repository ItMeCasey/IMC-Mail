import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'
import { holidaysBetween } from '@imc/mail/holidays'
import { appPrefs, notificationPrefs, planReminders, inQuietHours, type Summary } from '@imc/mail'
import { classify } from '@imc/core'
import { items, settings } from './db'

// Local notifications: reminders for meetings and holidays (scheduled with Android, so they show with the app closed),
// and a note about new mail found by the background check.

const REMINDERS = 'reminders'
const MAIL = 'mail'

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false })
})

/** Creates the notification channels (Android lists them in the system's notification settings) and asks permission once. */
export async function setUpNotifications(): Promise<boolean> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(REMINDERS, { name: 'Meeting and holiday reminders', importance: Notifications.AndroidImportance.HIGH })
    await Notifications.setNotificationChannelAsync(MAIL, { name: 'New mail', importance: Notifications.AndroidImportance.DEFAULT })
  }
  const have = await Notifications.getPermissionsAsync()
  if (have.granted) return true
  if (!have.canAskAgain) return false
  return (await Notifications.requestPermissionsAsync()).granted
}

const holidaysFor = (from: number, to: number) => {
  try {
    return holidaysBetween(appPrefs(items).holidayCountry, from, to)
  } catch {
    return []
  }
}

/**
 * Makes the reminders Android is holding match what the synced meetings and holidays call for: reminders that are no
 * longer wanted are cancelled, new ones scheduled. Safe to run as often as you like.
 */
export async function rescheduleReminders(now = Date.now()): Promise<number> {
  const granted = (await Notifications.getPermissionsAsync()).granted
  const waiting = await Notifications.getAllScheduledNotificationsAsync()
  const mine = waiting.filter((w) => w.identifier.startsWith('meeting:') || w.identifier.startsWith('holiday:'))
  const plan = granted ? planReminders(items, now, { holidays: holidaysFor }).slice(0, 60) : []
  const wanted = new Map(plan.map((p) => [p.id, p]))
  for (const w of mine) {
    const p = wanted.get(w.identifier)
    // Keep one that is still wanted at the same time; replace one that moved.
    const at = (w.trigger as { value?: number } | null)?.value
    if (!p || at !== p.at) await Notifications.cancelScheduledNotificationAsync(w.identifier)
    else wanted.delete(w.identifier)
  }
  for (const p of wanted.values()) {
    await Notifications.scheduleNotificationAsync({
      identifier: p.id,
      content: { title: p.title, body: p.body, data: { kind: p.kind } },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(p.at), channelId: REMINDERS }
    })
  }
  return plan.length
}

/** Tells the person about new mail, one notification for a burst. Details are left out if they chose that. */
export async function notifyNewMail(messages: Summary[], now = Date.now()): Promise<void> {
  if (messages.length === 0) return
  const prefs = notificationPrefs(items)
  if (!prefs.enabled || inQuietHours(prefs.quietHours, now)) return
  if (!(await Notifications.getPermissionsAsync()).granted) return
  const hide = settings.get().hideNotificationDetails
  const first = messages[0]!
  const who = first.from?.name || first.from?.address || 'Someone'
  const title = hide ? 'IMC-Mail' : messages.length === 1 ? who : `${messages.length} new messages`
  const body = hide ? (messages.length === 1 ? 'New message' : `${messages.length} new messages`) : messages.length === 1 ? first.subject || '(no subject)' : [...new Set(messages.map((m) => m.from?.name || m.from?.address || 'someone'))].slice(0, 3).join(', ')
  await Notifications.scheduleNotificationAsync({ content: { title, body, data: { kind: 'mail' } }, trigger: { channelId: MAIL } })
}

/** Which mail may notify, by the kinds the person chose on any device (everything, when streamer features are off). */
export function mailAllowed(): (m: Summary) => boolean {
  const prefs = notificationPrefs(items)
  if (!appPrefs(items).streamerFeatures) return () => true
  const allowed = new Set<string>(prefs.categories)
  return (m) => allowed.has(classify({ fromAddr: m.from?.address ?? '', fromName: m.from?.name ?? '', subject: m.subject }).category)
}
