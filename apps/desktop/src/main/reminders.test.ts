import { describe, expect, it } from 'vitest'
import { DEFAULT_NOTIFICATIONS } from './notifications'
import { ReminderService, type ReminderPrefs, type ReminderToast } from './reminders'

const MIN = 60_000
const at = (h: number, m = 0) => new Date(2026, 10, 3, h, m, 0, 0)

function setup(o: {
  now?: Date
  prefs?: Partial<ReminderPrefs>
  settings?: Partial<typeof DEFAULT_NOTIFICATIONS>
  stream?: boolean
  meetings?: { start: number; summary?: string; location?: string; allDay?: boolean; id?: string }[]
  holidays?: string[]
  lastHolidayDay?: string | null
}) {
  const shown: ReminderToast[] = []
  const state = { now: o.now ?? at(9, 50), lastHolidayDay: o.lastHolidayDay ?? null }
  const svc = new ReminderService({
    prefs: () => ({ meetings: true, leadMinutes: 10, holidays: false, ...o.prefs }),
    notifications: () => ({ ...DEFAULT_NOTIFICATIONS, ...o.settings }),
    streamActive: () => o.stream ?? false,
    meetings: (from, to) =>
      (o.meetings ?? [])
        .filter((m) => m.start >= from && m.start <= to)
        .map((m) => ({ start: m.start, end: m.start + 30 * MIN, event: { id: m.id ?? m.summary ?? 'a', summary: m.summary ?? '', location: m.location ?? '', allDay: m.allDay ?? false } })),
    holidaysOn: () => o.holidays ?? [],
    lastHolidayDay: () => state.lastHolidayDay,
    saveHolidayDay: (k) => {
      state.lastHolidayDay = k
    },
    show: (t) => shown.push(t),
    now: () => state.now
  })
  return { svc, shown, state }
}

describe('meeting reminders', () => {
  it('reminds once, when the meeting is inside the lead time', () => {
    const { svc, shown, state } = setup({ meetings: [{ start: at(10).getTime(), summary: 'Sponsor call', location: 'Zoom' }] })
    state.now = at(9, 40)
    svc.tick()
    expect(shown).toEqual([])
    state.now = at(9, 51)
    svc.tick()
    expect(shown).toEqual([{ title: 'Sponsor call', body: 'Starts in 9 minutes · Zoom' }])
    state.now = at(9, 52)
    svc.tick()
    expect(shown).toHaveLength(1)
  })

  it('says "1 minute" at the end and does not remind once the meeting has started', () => {
    const { svc, shown, state } = setup({ meetings: [{ start: at(10).getTime(), summary: 'Standup' }] })
    state.now = new Date(at(10).getTime() - 20_000)
    svc.tick()
    expect(shown[0]!.body).toBe('Starts in 1 minute')
    const late = setup({ now: at(10, 5), meetings: [{ start: at(10).getTime(), summary: 'Standup' }] })
    late.svc.tick()
    expect(late.shown).toEqual([])
  })

  it('uses the lead time from the settings', () => {
    const { svc, shown } = setup({ now: at(9, 30), prefs: { leadMinutes: 30 }, meetings: [{ start: at(10).getTime(), summary: 'Call' }] })
    svc.tick()
    expect(shown[0]!.body).toBe('Starts in 30 minutes')
  })

  it('skips all-day events, and does nothing when meeting reminders are off', () => {
    const allDay = setup({ meetings: [{ start: at(10).getTime(), summary: 'Conference', allDay: true }] })
    allDay.svc.tick()
    expect(allDay.shown).toEqual([])
    const off = setup({ prefs: { meetings: false }, meetings: [{ start: at(10).getTime(), summary: 'Call' }] })
    off.svc.tick()
    expect(off.shown).toEqual([])
  })

  it('combines several meetings that come due together', () => {
    const { svc, shown } = setup({
      meetings: [
        { start: at(10).getTime(), summary: 'A', id: 'a' },
        { start: at(9, 58).getTime(), summary: 'B', id: 'b' }
      ]
    })
    svc.tick()
    expect(shown).toHaveLength(1)
    expect(shown[0]!.title).toBe('2 meetings start soon')
    expect(shown[0]!.body).toBe('B in 8 minutes, A in 10 minutes')
  })

  it('reminds again for the next occurrence of a repeating meeting', () => {
    const day = 24 * 60 * MIN
    const { svc, shown, state } = setup({ meetings: [{ start: at(10).getTime(), summary: 'Weekly', id: 'w' }, { start: at(10).getTime() + day, summary: 'Weekly', id: 'w' }] })
    svc.tick()
    state.now = new Date(state.now.getTime() + day)
    svc.tick()
    expect(shown).toHaveLength(2)
  })
})

describe('the same rules as new-mail toasts', () => {
  const meeting = [{ start: at(10).getTime(), summary: 'Secret deal call' }]

  it('stays quiet when notifications are off or during quiet hours', () => {
    const off = setup({ settings: { enabled: false }, meetings: meeting })
    off.svc.tick()
    expect(off.shown).toEqual([])
    const quiet = setup({ settings: { quietHours: { enabled: true, start: '09:00', end: '11:00' } }, meetings: meeting })
    quiet.svc.tick()
    expect(quiet.shown).toEqual([])
  })

  it('is silent in stream-safe mode when set to silent, and generic when set to generic', () => {
    const silent = setup({ stream: true, meetings: meeting })
    silent.svc.tick()
    expect(silent.shown).toEqual([])
    const generic = setup({ stream: true, settings: { whenStreamSafe: 'generic' }, meetings: meeting })
    generic.svc.tick()
    expect(generic.shown).toEqual([{ title: 'IMC-Mail', body: 'A meeting starts soon' }])
    expect(JSON.stringify(generic.shown)).not.toContain('Secret')
  })
})

describe('holiday reminders', () => {
  it('shows once a day, and remembers it across restarts', () => {
    const { svc, shown, state } = setup({ prefs: { meetings: false, holidays: true }, holidays: ['Thanksgiving'] })
    svc.tick()
    svc.tick()
    expect(shown).toEqual([{ title: 'Holiday today', body: 'Thanksgiving' }])
    expect(state.lastHolidayDay).toBe('2026-11-3')
    const again = setup({ prefs: { meetings: false, holidays: true }, holidays: ['Thanksgiving'], lastHolidayDay: '2026-11-3' })
    again.svc.tick()
    expect(again.shown).toEqual([])
  })

  it('shows nothing on an ordinary day, or when turned off', () => {
    const plain = setup({ prefs: { meetings: false, holidays: true }, holidays: [] })
    plain.svc.tick()
    expect(plain.shown).toEqual([])
    const off = setup({ prefs: { meetings: false, holidays: false }, holidays: ['Thanksgiving'] })
    off.svc.tick()
    expect(off.shown).toEqual([])
  })

  it('does not name the holiday while stream-safe mode hides details', () => {
    const { svc, shown } = setup({ prefs: { meetings: false, holidays: true }, holidays: ['Thanksgiving'], stream: true, settings: { whenStreamSafe: 'generic' } })
    svc.tick()
    expect(shown[0]!.body).toBe('Today is a public holiday')
  })

  it('waits out quiet hours without using up the day', () => {
    const { svc, shown, state } = setup({
      prefs: { meetings: false, holidays: true },
      holidays: ['Thanksgiving'],
      now: at(7),
      settings: { quietHours: { enabled: true, start: '22:00', end: '08:00' } }
    })
    svc.tick()
    expect(shown).toEqual([])
    state.now = at(8, 30)
    svc.tick()
    expect(shown).toHaveLength(1)
  })
})
