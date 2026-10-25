import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  composeToast,
  DEFAULT_NOTIFICATIONS,
  inQuietHours,
  Notifier,
  skipReason,
  type Incoming,
  type Toast
} from './notifications'

const NOW = new Date(2026, 9, 25, 14, 30) // 14:30 local

const m = (over: Partial<Incoming> = {}): Incoming => ({
  id: 'm1',
  fromName: 'Nova Partnerships',
  fromAddr: 'p@nova.example',
  subject: 'Q4 brief',
  category: 'sponsorship',
  risk: 'none',
  date: NOW.getTime() - 60_000,
  unread: true,
  ...over
})

const S = DEFAULT_NOTIFICATIONS

describe('inQuietHours', () => {
  const q = (start: string, end: string, h: number, min = 0) =>
    inQuietHours({ enabled: true, start, end }, new Date(2026, 9, 25, h, min))
  it('handles a same-day window', () => {
    expect(q('09:00', '17:00', 12)).toBe(true)
    expect(q('09:00', '17:00', 8, 59)).toBe(false)
    expect(q('09:00', '17:00', 17)).toBe(false) // end is exclusive
  })
  it('handles a window that crosses midnight', () => {
    expect(q('22:00', '08:00', 23)).toBe(true)
    expect(q('22:00', '08:00', 3)).toBe(true)
    expect(q('22:00', '08:00', 8)).toBe(false)
    expect(q('22:00', '08:00', 14)).toBe(false)
  })
  it('is off when disabled or empty', () => {
    expect(inQuietHours({ enabled: false, start: '00:00', end: '23:59' }, NOW)).toBe(false)
    expect(q('10:00', '10:00', 10)).toBe(false)
  })
})

describe('skipReason', () => {
  it('lets fresh, unread, wanted mail through', () => {
    expect(skipReason(m(), S, NOW, false)).toBeNull()
  })
  it('skips by setting, state and content', () => {
    expect(skipReason(m(), { ...S, enabled: false }, NOW, false)).toMatch(/off/)
    expect(skipReason(m({ unread: false }), S, NOW, false)).toMatch(/read/)
    expect(skipReason(m({ risk: 'danger' }), S, NOW, false)).toMatch(/scam/)
    expect(skipReason(m({ category: 'cold' }), S, NOW, false)).toMatch(/muted/)
    expect(skipReason(m({ category: 'fan' }), S, NOW, false)).toMatch(/muted/)
    expect(skipReason(m({ date: NOW.getTime() - 3600e3 }), S, NOW, false)).toMatch(/Not new/)
  })
  it('suspicious (caution) mail still notifies', () => {
    expect(skipReason(m({ risk: 'caution' }), S, NOW, false)).toBeNull()
  })
  it('respects quiet hours', () => {
    const quiet = { ...S, quietHours: { enabled: true, start: '14:00', end: '15:00' } }
    expect(skipReason(m(), quiet, NOW, false)).toMatch(/Quiet/)
  })
  it('stays silent in stream-safe mode unless generic is chosen', () => {
    expect(skipReason(m(), S, NOW, true)).toMatch(/Stream-safe/)
    expect(skipReason(m(), { ...S, whenStreamSafe: 'generic' }, NOW, true)).toBeNull()
  })
})

describe('composeToast', () => {
  it('names the sender and subject for one message', () => {
    expect(composeToast([m()], S, false)).toEqual({ title: 'Nova Partnerships', body: 'Q4 brief', messageId: 'm1' })
    expect(composeToast([m({ fromName: '', subject: '' })], S, false)).toMatchObject({ title: 'p@nova.example', body: '(no subject)' })
  })
  it('tallies a burst', () => {
    const t = composeToast(
      [m({ id: 'a', fromName: 'A' }), m({ id: 'b', fromName: 'B' }), m({ id: 'c', fromName: 'A' }), m({ id: 'd', fromName: 'D' }), m({ id: 'e', fromName: 'E' })],
      S,
      false
    )
    expect(t).toEqual({ title: '5 new messages', body: 'A, B, D, +1 more', messageId: 'a' })
  })
  it('reveals nothing while stream-safe is on', () => {
    const t = composeToast([m(), m({ id: 'm2' })], { ...S, whenStreamSafe: 'generic' }, true)!
    expect(t).toEqual({ title: 'IMC-Mail', body: '2 new messages', messageId: null })
    expect(JSON.stringify(composeToast([m()], S, true))).not.toMatch(/Nova|Q4/)
  })
  it('returns nothing for an empty burst', () => {
    expect(composeToast([], S, false)).toBeNull()
  })
})

describe('Notifier', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const make = (over: { stream?: () => boolean; settings?: () => typeof S } = {}) => {
    const shown: Toast[] = []
    const store = new Map<string, Incoming>()
    const n = new Notifier({
      getSettings: over.settings ?? (() => S),
      streamActive: over.stream ?? (() => false),
      load: (ids) => ids.map((i) => store.get(i)).filter((x): x is Incoming => !!x),
      show: (t) => shown.push(t),
      now: () => NOW
    })
    return { n, shown, add: (x: Incoming) => store.set(x.id, x) }
  }

  it('turns a burst into one toast after a short wait', () => {
    const t = make()
    t.add(m({ id: 'a', fromName: 'A' }))
    t.add(m({ id: 'b', fromName: 'B' }))
    t.n.handleNew(['a'])
    t.n.handleNew(['b'])
    expect(t.shown).toHaveLength(0)
    vi.advanceTimersByTime(1600)
    expect(t.shown).toEqual([{ title: '2 new messages', body: 'A, B', messageId: 'a' }])
  })

  it('shows nothing when every message is filtered out', () => {
    const t = make()
    t.add(m({ id: 'a', category: 'cold' }))
    t.n.handleNew(['a', 'missing'])
    vi.advanceTimersByTime(3000)
    expect(t.shown).toEqual([])
  })

  it('re-checks stream-safe at the moment of showing', () => {
    let live = false
    const t = make({ stream: () => live, settings: () => ({ ...S, whenStreamSafe: 'generic' }) })
    t.add(m({ id: 'a' }))
    t.n.handleNew(['a'])
    live = true // OBS started while the burst was collecting
    vi.advanceTimersByTime(1600)
    expect(t.shown).toEqual([{ title: 'IMC-Mail', body: 'New message', messageId: null }])
  })

  it('stop() drops anything pending', () => {
    const t = make()
    t.add(m({ id: 'a' }))
    t.n.handleNew(['a'])
    t.n.stop()
    vi.advanceTimersByTime(3000)
    expect(t.shown).toEqual([])
  })
})
