import { describe, expect, it } from 'vitest'
import { itemStore, migrate } from './phonedb'
import { memoryDb } from './test-db'
import { appPrefs, DEFAULT_APP_PREFS, followUpFor, labelsByMessage, listDeals, listLabels, meetingsBetween, notificationPrefs, outstanding, setAppPrefs, setDealStage, setLabel, setSnooze, snoozedNow, snoozedUntil } from './synced'

const fresh = () => {
  const db = memoryDb()
  migrate(db)
  return itemStore(db)
}

describe('labels', () => {
  it('lists them by name, and finds the labels on each message of one account only', () => {
    const items = fresh()
    items.put('label', 'l1', { name: 'taxes' })
    items.put('label', 'l2', { name: 'Sponsors' })
    expect(listLabels(items).map((l) => l.name)).toEqual(['Sponsors', 'taxes'])
    setLabel(items, 'Me@Example.com', '<a@x>', 'l1', true)
    setLabel(items, 'me@example.com', '<a@x>', 'l2', true)
    setLabel(items, 'me@example.com', '<b@x>', 'l2', true)
    setLabel(items, 'other@example.com', '<a@x>', 'l1', true)
    const map = labelsByMessage(items, 'me@example.com')
    expect(map.get('<a@x>')!.sort()).toEqual(['l1', 'l2'])
    expect(map.get('<b@x>')).toEqual(['l2'])
    expect(map.size).toBe(2)
    setLabel(items, 'me@example.com', '<a@x>', 'l1', false)
    expect(labelsByMessage(items, 'me@example.com').get('<a@x>')).toEqual(['l2'])
  })

  it('does not label a message whose id is too long to sync', () => {
    const items = fresh()
    setLabel(items, 'me@example.com', `<${'x'.repeat(300)}@x>`, 'l1', true)
    expect(items.list('messageLabel')).toEqual([])
  })
})

describe('snooze and follow-up', () => {
  it('snoozes, reports who is snoozed right now, and wakes', () => {
    const items = fresh()
    setSnooze(items, 'me@example.com', '<a@x>', 2000)
    setSnooze(items, 'me@example.com', '<b@x>', 500)
    setSnooze(items, 'other@example.com', '<c@x>', 2000)
    expect(snoozedUntil(items, 'ME@example.com', '<a@x>')).toBe(2000)
    expect([...snoozedNow(items, 'me@example.com', 1000)]).toEqual(['<a@x>'])
    expect([...snoozedNow(items, 'me@example.com', 3000)]).toEqual([])
    setSnooze(items, 'me@example.com', '<a@x>', null)
    expect(snoozedUntil(items, 'me@example.com', '<a@x>')).toBeNull()
  })

  it('reads a follow-up that came from another device', () => {
    const items = fresh()
    items.put('followUp', 'me@example.com\u001f<a@x>', { due: 9, fired: true })
    expect(followUpFor(items, 'me@example.com', '<a@x>')).toEqual({ due: 9, fired: true })
    expect(followUpFor(items, 'me@example.com', '<none@x>')).toBeNull()
  })
})

describe('deals', () => {
  const deal = (over: Record<string, unknown> = {}) => ({ account: 'me@example.com', rfcId: null, brand: 'Acme', stage: 'lead', rate: 100, currency: 'USD', deliverables: '', dueDate: null, notes: '', createdAt: 1, updatedAt: 1, paidAt: null, ...over })

  it('lists open deals before finished ones, newest change first', () => {
    const items = fresh()
    items.put('deal', 'a', deal({ brand: 'Old open', updatedAt: 1 }))
    items.put('deal', 'b', deal({ brand: 'Paid', stage: 'paid', updatedAt: 9 }))
    items.put('deal', 'c', deal({ brand: 'New open', stage: 'negotiating', updatedAt: 5 }))
    expect(listDeals(items).map((d) => d.brand)).toEqual(['New open', 'Old open', 'Paid'])
  })

  it('moves a deal between stages, stamping the paid date and clearing it again', () => {
    const items = fresh()
    items.put('deal', 'a', deal())
    expect(setDealStage(items, 'a', 'paid', 50)).toMatchObject({ stage: 'paid', paidAt: 50, updatedAt: 50 })
    expect(setDealStage(items, 'a', 'delivered', 60)).toMatchObject({ stage: 'delivered', paidAt: null })
    expect(setDealStage(items, 'nope', 'paid', 1)).toBeNull()
  })

  it('adds up what is still owed, by currency', () => {
    const items = fresh()
    items.put('deal', 'a', deal({ stage: 'contracted', rate: 500 }))
    items.put('deal', 'b', deal({ stage: 'delivered', rate: 250 }))
    items.put('deal', 'c', deal({ stage: 'delivered', rate: 100, currency: 'EUR' }))
    items.put('deal', 'd', deal({ stage: 'lead', rate: 999 }))
    items.put('deal', 'e', deal({ stage: 'paid', rate: 999 }))
    items.put('deal', 'f', deal({ stage: 'delivered', rate: null }))
    expect(outstanding(listDeals(items))).toEqual(new Map([['USD', 750], ['EUR', 100]]))
  })
})

describe('the calendar', () => {
  const day = 86_400_000
  const T = Date.UTC(2026, 10, 2, 15)
  const meeting = (over: Record<string, unknown> = {}) => ({ sequence: 1, summary: 'Call', description: '', location: '', start: T, end: T + 3_600_000, allDay: false, rrule: null, exdates: [], organizer: null, attendees: [], status: 'CONFIRMED', onlineUrl: null, myResponse: 'accepted', mine: false, free: false, ...over })

  it('lists meetings in range, in order, and leaves out cancelled and declined ones', () => {
    const items = fresh()
    items.put('meeting', 'me@example.com\u001fa@x\u001f', meeting({ summary: 'Later', start: T + day, end: T + day + 3_600_000 }))
    items.put('meeting', 'me@example.com\u001fb@x\u001f', meeting({ summary: 'Sooner' }))
    items.put('meeting', 'me@example.com\u001fc@x\u001f', meeting({ summary: 'Cancelled', status: 'CANCELLED' }))
    items.put('meeting', 'me@example.com\u001fd@x\u001f', meeting({ summary: 'Declined', myResponse: 'declined' }))
    items.put('meeting', 'me@example.com\u001fe@x\u001f', meeting({ summary: 'Outside', start: T + 40 * day, end: T + 40 * day + 3_600_000 }))
    expect(meetingsBetween(items, T - day, T + 7 * day).map((o) => o.summary)).toEqual(['Sooner', 'Later'])
  })

  it('expands a repeating meeting, and shows a moved occurrence from its own item', () => {
    const items = fresh()
    items.put('meeting', 'me@example.com\u001fseries@x\u001f', meeting({ summary: 'Weekly', rrule: 'FREQ=WEEKLY;COUNT=4' }))
    const week = 7 * day
    expect(meetingsBetween(items, T - day, T + 5 * week).map((o) => o.start)).toEqual([T, T + week, T + 2 * week, T + 3 * week])
    items.put('meeting', `me@example.com\u001fseries@x\u001f${T + week}`, meeting({ summary: 'Weekly (moved)', start: T + week + 2 * 3_600_000, end: T + week + 3 * 3_600_000 }))
    const list = meetingsBetween(items, T - day, T + 5 * week)
    expect(list.map((o) => o.summary)).toEqual(['Weekly', 'Weekly (moved)', 'Weekly', 'Weekly'])
    expect(list[1]!.start).toBe(T + week + 2 * 3_600_000)
  })

  it('carries the join link and the account', () => {
    const items = fresh()
    items.put('meeting', 'me@example.com\u001fa@x\u001f', meeting({ onlineUrl: 'https://meet.example/x' }))
    expect(meetingsBetween(items, T - day, T + day)[0]).toMatchObject({ account: 'me@example.com', uid: 'a@x', onlineUrl: 'https://meet.example/x', myResponse: 'accepted' })
  })
})

describe('preferences', () => {
  it('falls back to defaults, and keeps changes', () => {
    const items = fresh()
    expect(appPrefs(items)).toEqual(DEFAULT_APP_PREFS)
    expect(notificationPrefs(items).enabled).toBe(true)
    expect(setAppPrefs(items, { showHolidays: true, holidayCountry: 'GB' })).toMatchObject({ showHolidays: true, holidayCountry: 'GB', meetingReminders: true })
    expect(appPrefs(items).holidayCountry).toBe('GB')
    items.put('pref', 'notifications', { enabled: false })
    expect(notificationPrefs(items)).toMatchObject({ enabled: false, quietHours: { enabled: false } })
  })
})
