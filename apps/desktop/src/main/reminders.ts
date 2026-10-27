import type { NotificationSettings } from '@imc/core'
import { inQuietHours } from './notifications'

export interface ReminderToast {
  title: string
  body: string
}

export interface ReminderPrefs {
  meetings: boolean
  /** How many minutes before a meeting to remind. */
  leadMinutes: number
  holidays: boolean
}

interface Upcoming {
  start: number
  end: number
  event: { id: string; summary: string; location: string; allDay: boolean }
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`

/**
 * Reminders for meetings that are about to start and for public holidays, shown as Windows toasts.
 * They follow the same switches as new-mail toasts: off means off, quiet hours are quiet, and while
 * stream-safe mode is on they are either silent or say nothing about what the meeting is.
 * Kept free of Electron so it can be tested.
 */
export class ReminderService {
  private timer: NodeJS.Timeout | null = null
  /** Meetings already reminded about, so a reminder shows once. */
  private fired = new Map<string, number>()

  constructor(
    private deps: {
      prefs: () => ReminderPrefs
      notifications: () => NotificationSettings
      streamActive: () => boolean
      /** Meetings starting between `from` and `to` (epoch ms). */
      meetings: (from: number, to: number) => Upcoming[]
      /** Names of the public holidays on this day. */
      holidaysOn: (day: Date) => string[]
      /** The day a holiday reminder was last shown, as saved. */
      lastHolidayDay: () => string | null
      saveHolidayDay: (key: string) => void
      show: (t: ReminderToast) => void
      now?: () => Date
    }
  ) {}

  private now = () => (this.deps.now ?? (() => new Date()))()

  start(everyMs = 30_000): void {
    this.stop()
    this.timer = setInterval(() => this.tick(), everyMs)
    // The first look comes shortly after start, once the calendar has been read.
    setTimeout(() => this.tick(), 5_000).unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Looks at the clock and shows whatever has come due. */
  tick(): void {
    const prefs = this.deps.prefs()
    if (!prefs.meetings && !prefs.holidays) return
    const settings = this.deps.notifications()
    const now = this.now()
    if (!settings.enabled || inQuietHours(settings.quietHours, now)) return
    const active = this.deps.streamActive()
    if (active && settings.whenStreamSafe === 'silent') return
    if (prefs.meetings) this.meetingReminders(prefs.leadMinutes, now, active)
    if (prefs.holidays) this.holidayReminder(now, active)
  }

  private meetingReminders(leadMinutes: number, now: Date, hidden: boolean): void {
    const t = now.getTime()
    // Forget old entries so the list does not grow for as long as the app runs.
    for (const [k, at] of this.fired) if (at < t - 86_400_000) this.fired.delete(k)
    const due = this.deps
      .meetings(t, t + leadMinutes * 60_000)
      .filter((o) => !o.event.allDay && o.start > t && o.start - leadMinutes * 60_000 <= t)
      .filter((o) => !this.fired.has(`${o.event.id}:${o.start}`))
      .sort((a, b) => a.start - b.start)
    if (due.length === 0) return
    for (const o of due) this.fired.set(`${o.event.id}:${o.start}`, o.start)

    const minutes = (o: Upcoming) => Math.max(1, Math.ceil((o.start - t) / 60_000))
    const when = (o: Upcoming) => (minutes(o) === 1 ? 'in 1 minute' : `in ${minutes(o)} minutes`)
    if (hidden) {
      this.deps.show({ title: 'IMC-Mail', body: due.length === 1 ? 'A meeting starts soon' : `${due.length} meetings start soon` })
    } else if (due.length === 1) {
      const o = due[0]!
      this.deps.show({ title: o.event.summary || 'Meeting', body: `Starts ${when(o)}${o.event.location ? ` · ${o.event.location}` : ''}` })
    } else {
      this.deps.show({
        title: `${due.length} meetings start soon`,
        body: due
          .slice(0, 3)
          .map((o) => `${o.event.summary || 'Meeting'} ${when(o)}`)
          .join(', ') + (due.length > 3 ? `, +${due.length - 3} more` : '')
      })
    }
  }

  private holidayReminder(now: Date, hidden: boolean): void {
    const key = dayKey(now)
    if (this.deps.lastHolidayDay() === key) return
    const names = this.deps.holidaysOn(now)
    this.deps.saveHolidayDay(key)
    if (names.length === 0) return
    this.deps.show({ title: 'Holiday today', body: hidden ? 'Today is a public holiday' : names.join(', ') })
  }
}
