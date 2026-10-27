import type { Summary } from './imap'
import type { itemStore } from './phonedb'
import { appPrefs, meetingsBetween, notificationPrefs } from './synced'

// Working out which reminders the phone should have waiting. Nothing is shown here: this makes the list, and the app
// hands it to Android, which shows each at its time even while IMC-Mail is closed.

type Items = ReturnType<typeof itemStore>

export interface Planned {
  /** The same reminder always has the same id, so a plan can be compared with what is already waiting. */
  id: string
  /** When to show it, epoch ms. */
  at: number
  title: string
  body: string
  kind: 'meeting' | 'holiday'
}

export interface PlanOptions {
  /** How far ahead to plan. */
  horizonMs?: number
  /** Public holidays between two times, for the person's country. */
  holidays?: (from: number, to: number) => { date: string; name: string }[]
}

const minutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

/** True when a moment falls inside quiet hours, including a window that crosses midnight. */
export function inQuietHours(q: { enabled: boolean; start: string; end: string }, at: number): boolean {
  if (!q.enabled) return false
  const d = new Date(at)
  const t = d.getHours() * 60 + d.getMinutes()
  const a = minutes(q.start)
  const b = minutes(q.end)
  if (a === b) return false
  return a < b ? t >= a && t < b : t >= a || t < b
}

/**
 * The messages worth a notification after a refresh: new since the last look, still unread, and recent. The very first
 * refresh of a folder (nothing saved before) tells you about nothing, since everything in it is old news. `allowed`
 * decides which kinds of mail may notify (return false to leave one out).
 */
export function newMailToNotify(before: Summary[] | null, after: Summary[], opts: { now: number; maxAgeMs?: number; allowed?: (m: Summary) => boolean }): Summary[] {
  if (before === null || before.length === 0) return []
  const had = new Set(before.map((m) => m.uid))
  const maxAge = opts.maxAgeMs ?? 6 * 3_600_000
  return after
    .filter((m) => !had.has(m.uid) && !m.flags.includes('\\Seen') && !m.flags.includes('\\Deleted'))
    .filter((m) => m.date === null || opts.now - m.date <= maxAge)
    .filter((m) => opts.allowed?.(m) ?? true)
    .sort((a, b) => (b.date ?? 0) - (a.date ?? 0))
}

const HOLIDAY_HOUR = 8
const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

/** The reminders to have waiting: before each meeting, and on the morning of a holiday, as the person chose. */
export function planReminders(items: Items, now: number, opts: PlanOptions = {}): Planned[] {
  const prefs = appPrefs(items)
  const notify = notificationPrefs(items)
  if (!notify.enabled) return []
  const horizon = now + (opts.horizonMs ?? 3 * 86_400_000)
  const out: Planned[] = []

  if (prefs.meetingReminders) {
    for (const m of meetingsBetween(items, now, horizon)) {
      if (m.allDay || m.start <= now + 60_000) continue
      // A meeting that starts inside the lead time is reminded about straight away.
      const at = Math.max(m.start - prefs.reminderLeadMinutes * 60_000, now + 5_000)
      if (inQuietHours(notify.quietHours, at)) continue
      out.push({ id: `meeting:${m.id}`, at, kind: 'meeting', title: m.summary || 'Meeting', body: `Starts at ${clock.format(m.start)}${m.location ? ` · ${m.location}` : ''}` })
    }
  }

  if (prefs.holidayReminders && opts.holidays) {
    for (const h of opts.holidays(now, horizon)) {
      const [y, mo, d] = h.date.split('-').map(Number)
      const at = new Date(y!, mo! - 1, d!, HOLIDAY_HOUR).getTime()
      if (at <= now || at > horizon || inQuietHours(notify.quietHours, at)) continue
      out.push({ id: `holiday:${h.date}:${h.name}`, at, kind: 'holiday', title: 'Holiday today', body: h.name })
    }
  }
  return out.sort((a, b) => a.at - b.at)
}
