import { occurrences, splitSyncKey, syncKey, type AppPrefs, type CalEvent, type DealData, type MeetingData, type NotificationSettings } from '@imc/core'
import type { itemStore } from './phonedb'

// Reading and changing the items synced from your other devices, in the terms the phone's screens use: the labels on a
// message, whether it is snoozed, your deals, the meetings in the next weeks, and your preferences.

type Items = ReturnType<typeof itemStore>

export const DEFAULT_APP_PREFS: AppPrefs = { streamerFeatures: true, showHolidays: false, holidayCountry: 'US', meetingReminders: true, reminderLeadMinutes: 10, holidayReminders: false }
export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  enabled: true,
  categories: ['sponsorship', 'collab', 'platform', 'invoice', 'other'],
  quietHours: { enabled: false, start: '22:00', end: '08:00' },
  whenStreamSafe: 'silent'
}

export const appPrefs = (items: Items): AppPrefs => ({ ...DEFAULT_APP_PREFS, ...(items.get<Partial<AppPrefs>>('pref', 'app') ?? {}) })
export const notificationPrefs = (items: Items): NotificationSettings => ({ ...DEFAULT_NOTIFICATIONS, ...(items.get<Partial<NotificationSettings>>('pref', 'notifications') ?? {}) })

/** Changes one or more app preferences. They go to your other devices at the next sync. */
export function setAppPrefs(items: Items, change: Partial<AppPrefs>): AppPrefs {
  const next = { ...appPrefs(items), ...change }
  items.put('pref', 'app', next)
  return next
}

// ---- labels ------------------------------------------------------------------------------------------------------------

export interface Label {
  id: string
  name: string
}

export const listLabels = (items: Items): Label[] =>
  items
    .list<{ name: string }>('label')
    .map((l) => ({ id: l.id, name: l.data.name }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))

/** Which labels are on which messages of an account: Message-ID to label ids. Built once for a whole list. */
export function labelsByMessage(items: Items, account: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const who = account.toLowerCase()
  for (const { id } of items.list('messageLabel')) {
    const [email, rfcId, labelId] = splitSyncKey(id)
    if (!email || !rfcId || !labelId || email.toLowerCase() !== who) continue
    out.set(rfcId, [...(out.get(rfcId) ?? []), labelId])
  }
  return out
}

/** Puts a label on a message, or takes it off. */
export function setLabel(items: Items, account: string, rfcId: string, labelId: string, on: boolean): void {
  const id = syncKey(account.toLowerCase(), rfcId, labelId)
  if (!id) return
  if (on) items.put('messageLabel', id, { on: true })
  else items.remove('messageLabel', id)
}

// ---- snooze and follow-up ----------------------------------------------------------------------------------------------

/** Until when a message is snoozed (epoch ms), or null. */
export function snoozedUntil(items: Items, account: string, rfcId: string): number | null {
  const id = syncKey(account.toLowerCase(), rfcId)
  return id ? (items.get<{ until: number }>('snooze', id)?.until ?? null) : null
}

/** Message-IDs of an account that are snoozed past `now`: the inbox leaves them out. */
export function snoozedNow(items: Items, account: string, now: number): Set<string> {
  const out = new Set<string>()
  const who = account.toLowerCase()
  for (const { id, data } of items.list<{ until: number }>('snooze')) {
    const [email, rfcId] = splitSyncKey(id)
    if (email?.toLowerCase() === who && rfcId && data.until > now) out.add(rfcId)
  }
  return out
}

/** Snoozes a message until a time, or wakes it (`until` null). */
export function setSnooze(items: Items, account: string, rfcId: string, until: number | null): void {
  const id = syncKey(account.toLowerCase(), rfcId)
  if (!id) return
  if (until === null) items.remove('snooze', id)
  else items.put('snooze', id, { until })
}

export function followUpFor(items: Items, account: string, rfcId: string): { due: number; fired: boolean } | null {
  const id = syncKey(account.toLowerCase(), rfcId)
  return id ? items.get<{ due: number; fired: boolean }>('followUp', id) : null
}

// ---- deals -------------------------------------------------------------------------------------------------------------

export interface Deal extends DealData {
  id: string
}

export const DEAL_STAGES = ['lead', 'negotiating', 'contracted', 'delivered', 'paid', 'passed'] as const

/** Deals, the ones still open first, the most recently changed first within a group. */
export function listDeals(items: Items): Deal[] {
  const open = (d: Deal) => (d.stage === 'paid' || d.stage === 'passed' ? 1 : 0)
  return items
    .list<DealData>('deal')
    .map((d) => ({ id: d.id, ...d.data }))
    .sort((a, b) => open(a) - open(b) || b.updatedAt - a.updatedAt)
}

/** Moves a deal to another stage. Moving to Paid stamps the date; moving back clears it. */
export function setDealStage(items: Items, id: string, stage: Deal['stage'], now: number): Deal | null {
  const cur = items.get<DealData>('deal', id)
  if (!cur) return null
  const next: DealData = { ...cur, stage, updatedAt: now, paidAt: stage === 'paid' ? (cur.paidAt ?? now) : null }
  items.put('deal', id, next)
  return { id, ...next }
}

/** Money still to come from deals that are agreed but not paid, by currency. */
export function outstanding(deals: Deal[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const d of deals) if ((d.stage === 'contracted' || d.stage === 'delivered') && d.rate !== null) out.set(d.currency, (out.get(d.currency) ?? 0) + d.rate)
  return out
}

// ---- the calendar ------------------------------------------------------------------------------------------------------

export interface Occurrence {
  /** The meeting's id (account, uid and which occurrence). */
  id: string
  account: string
  uid: string
  summary: string
  location: string
  start: number
  end: number
  allDay: boolean
  onlineUrl: string | null
  myResponse: MeetingData['myResponse']
}

const asEvent = (m: MeetingData, uid: string): CalEvent => ({ method: null, uid, sequence: m.sequence, recurrenceId: null, summary: m.summary, description: m.description, location: m.location, start: m.start, end: m.end, allDay: m.allDay, rrule: m.rrule, exdates: m.exdates, organizer: m.organizer, attendees: [], status: m.status, onlineUrl: m.onlineUrl, dtstamp: null, free: m.free })

/**
 * The meetings that fall between two times, repeating ones expanded, in order. Cancelled meetings and ones you declined
 * are left out. A changed single occurrence of a series replaces the one it was moved from.
 */
export function meetingsBetween(items: Items, from: number, to: number): Occurrence[] {
  const rows = items.list<MeetingData>('meeting').map((r) => ({ key: r.id, parts: splitSyncKey(r.id), data: r.data }))
  const overridden = new Set<string>()
  for (const r of rows) {
    const [email, uid, rec] = r.parts
    if (rec) overridden.add(`${email}\u001f${uid}\u001f${rec}`)
  }
  const out: Occurrence[] = []
  for (const r of rows) {
    const [email = '', uid = '', rec = ''] = r.parts
    if (r.data.status === 'CANCELLED' || r.data.myResponse === 'declined') continue
    const ev = asEvent(r.data, uid)
    const times = rec ? (r.data.start < to && r.data.end > from ? [r.data.start] : []) : occurrences(ev, from, to)
    for (const t of times) {
      // A series occurrence that has its own item (it was moved or changed) is shown from that item instead.
      if (!rec && overridden.has(`${email}\u001f${uid}\u001f${t}`)) continue
      out.push({ id: `${r.key}\u001f${t}`, account: email, uid, summary: r.data.summary, location: r.data.location, start: t, end: t + (r.data.end - r.data.start), allDay: r.data.allDay, onlineUrl: r.data.onlineUrl, myResponse: r.data.myResponse })
    }
  }
  return out.sort((a, b) => a.start - b.start || a.summary.localeCompare(b.summary))
}
