import { describe, expect, it } from 'vitest'
import { inQuietHours, newMailToNotify, planReminders } from './reminders'
import type { Summary } from './imap'
import { itemStore, migrate } from './phonedb'
import { memoryDb } from './test-db'
import { setAppPrefs } from './synced'

const fresh = () => {
  const db = memoryDb()
  migrate(db)
  return itemStore(db)
}
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime()
const meeting = (start: number, over: Record<string, unknown> = {}) => ({ sequence: 1, summary: 'Sponsor call', description: '', location: 'Zoom', start, end: start + 3_600_000, allDay: false, rrule: null, exdates: [], organizer: null, attendees: [], status: 'CONFIRMED', onlineUrl: null, myResponse: 'accepted', mine: false, free: false, ...over })

describe('planning reminders', () => {
  it('reminds a set time before each meeting, in order', () => {
    const items = fresh()
    items.put('meeting', 'me@x\u001fa@x\u001f', meeting(at(3, 15)))
    items.put('meeting', 'me@x\u001fb@x\u001f', meeting(at(3, 11), { summary: 'Standup', location: '' }))
    const plan = planReminders(items, at(3, 9))
    expect(plan.map((p) => [p.title, p.at])).toEqual([['Standup', at(3, 10, 50)], ['Sponsor call', at(3, 14, 50)]])
    expect(plan[1]!.body).toContain('Zoom')
    expect(plan[0]!.id).toBe(planReminders(items, at(3, 9, 30))[0]!.id)
  })

  it('uses the lead time the person chose, and does nothing when meeting reminders are off', () => {
    const items = fresh()
    items.put('meeting', 'me@x\u001fa@x\u001f', meeting(at(3, 15)))
    setAppPrefs(items, { reminderLeadMinutes: 30 })
    expect(planReminders(items, at(3, 9))[0]!.at).toBe(at(3, 14, 30))
    setAppPrefs(items, { meetingReminders: false })
    expect(planReminders(items, at(3, 9))).toEqual([])
  })

  it('reminds at once for a meeting that starts inside the lead time, and skips one that has started or is all day', () => {
    const items = fresh()
    items.put('meeting', 'me@x\u001fa@x\u001f', meeting(at(3, 9, 5)))
    items.put('meeting', 'me@x\u001fb@x\u001f', meeting(at(3, 8, 59)))
    items.put('meeting', 'me@x\u001fc@x\u001f', meeting(at(3, 12), { allDay: true }))
    const plan = planReminders(items, at(3, 9))
    expect(plan).toHaveLength(1)
    expect(plan[0]!.at).toBe(at(3, 9) + 5_000)
  })

  it('stays quiet during quiet hours and when notifications are off', () => {
    const items = fresh()
    items.put('meeting', 'me@x\u001fa@x\u001f', meeting(at(3, 7, 30)))
    items.put('pref', 'notifications', { enabled: true, categories: [], quietHours: { enabled: true, start: '22:00', end: '08:00' }, whenStreamSafe: 'silent' })
    expect(planReminders(items, at(2, 20))).toEqual([])
    items.put('pref', 'notifications', { enabled: false })
    items.put('meeting', 'me@x\u001fb@x\u001f', meeting(at(3, 15)))
    expect(planReminders(items, at(2, 20))).toEqual([])
  })

  it('plans a holiday for the morning of the day, only when asked for and inside the horizon', () => {
    const items = fresh()
    const holidays = () => [{ date: '2026-11-26', name: 'Thanksgiving' }, { date: '2026-11-03', name: 'Too late today' }, { date: '2026-12-25', name: 'Christmas Day' }]
    expect(planReminders(items, at(2, 12), { holidays, horizonMs: 30 * 86_400_000 })).toEqual([])
    setAppPrefs(items, { holidayReminders: true })
    const plan = planReminders(items, at(3, 9), { holidays, horizonMs: 30 * 86_400_000 })
    expect(plan.map((p) => [p.title, p.body, p.at])).toEqual([['Holiday today', 'Thanksgiving', new Date(2026, 10, 26, 8).getTime()]])
    expect(planReminders(items, at(3, 9), {})).toEqual([])
  })
})

describe('new mail to notify about', () => {
  const NOW = 10_000_000
  const m = (uid: number, over: Partial<Summary> = {}): Summary => ({ uid, flags: [], internalDate: null, size: 1, from: null, to: [], cc: [], subject: `s${uid}`, messageId: null, inReplyTo: null, references: [], date: NOW - 1000, ...over })

  it('tells about new, unread, recent messages, newest first', () => {
    const before = [m(1), m(2)]
    const after = [m(1), m(2), m(3, { date: NOW - 5000 }), m(4, { date: NOW - 100 }), m(5, { flags: ['\\Seen'] }), m(6, { date: NOW - 7 * 3_600_000 })]
    expect(newMailToNotify(before, after, { now: NOW }).map((x) => x.uid)).toEqual([4, 3])
  })

  it('says nothing the first time a folder is looked at, or when nothing is new', () => {
    expect(newMailToNotify(null, [m(1)], { now: NOW })).toEqual([])
    expect(newMailToNotify([], [m(1)], { now: NOW })).toEqual([])
    expect(newMailToNotify([m(1)], [m(1)], { now: NOW })).toEqual([])
  })

  it('leaves out the kinds of mail the person muted', () => {
    const after = [m(1), m(2, { subject: 'fan mail' }), m(3, { subject: 'sponsorship' })]
    expect(newMailToNotify([m(1)], after, { now: NOW, allowed: (x) => x.subject !== 'fan mail' }).map((x) => x.uid)).toEqual([3])
  })
})

describe('quiet hours', () => {
  const q = { enabled: true, start: '22:00', end: '08:00' }
  it('covers a window that crosses midnight, and a same-day window', () => {
    expect(inQuietHours(q, at(3, 23))).toBe(true)
    expect(inQuietHours(q, at(3, 3))).toBe(true)
    expect(inQuietHours(q, at(3, 8))).toBe(false)
    expect(inQuietHours(q, at(3, 15))).toBe(false)
    expect(inQuietHours({ enabled: true, start: '09:00', end: '17:00' }, at(3, 12))).toBe(true)
    expect(inQuietHours({ ...q, enabled: false }, at(3, 23))).toBe(false)
    expect(inQuietHours({ enabled: true, start: '08:00', end: '08:00' }, at(3, 8))).toBe(false)
  })
})
