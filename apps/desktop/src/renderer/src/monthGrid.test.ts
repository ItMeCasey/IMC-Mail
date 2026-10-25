import { describe, expect, it } from 'vitest'
import { dayKey, groupByDay, monthGrid } from './monthGrid'

describe('monthGrid', () => {
  it('draws whole Sunday-first weeks around the month', () => {
    const weeks = monthGrid(2026, 10) // November 2026 starts on a Sunday and has 30 days
    expect(weeks).toHaveLength(5)
    expect(weeks.every((w) => w.length === 7 && w[0]!.getDay() === 0)).toBe(true)
    expect(dayKey(weeks[0]![0]!)).toBe('2026-11-01')
    expect(dayKey(weeks[4]![6]!)).toBe('2026-12-05')
  })
  it('starts in the previous month when the 1st is midweek, and can need six weeks', () => {
    const oct = monthGrid(2026, 9) // October 1st 2026 is a Thursday
    expect(dayKey(oct[0]![0]!)).toBe('2026-09-27')
    expect(monthGrid(2026, 7)).toHaveLength(6) // August 2026 starts on a Saturday and has 31 days
  })
  it('works across a year end', () => {
    const dec = monthGrid(2026, 11)
    expect(dec.flat().some((d) => dayKey(d) === '2027-01-02')).toBe(true)
  })
})

describe('groupByDay', () => {
  const at = (m: number, d: number, h = 0) => new Date(2026, m, d, h).getTime()
  const meeting = (start: number, end: number, allDay = false) => ({ start, end, event: { allDay } })
  it('puts a meeting on its day, and on both days when it crosses midnight', () => {
    const a = meeting(at(10, 4, 14), at(10, 4, 15))
    const b = meeting(at(10, 4, 23), at(10, 5, 1))
    const g = groupByDay([a, b])
    expect(g.get('2026-11-04')).toEqual([a, b])
    expect(g.get('2026-11-05')).toEqual([b])
  })
  it('does not spill a meeting that ends exactly at midnight onto the next day', () => {
    const g = groupByDay([meeting(at(10, 4, 22), at(10, 5, 0))])
    expect([...g.keys()]).toEqual(['2026-11-04'])
  })
  it('treats the end of an all-day meeting as exclusive', () => {
    const g = groupByDay([meeting(at(10, 6), at(10, 8), true)])
    expect([...g.keys()]).toEqual(['2026-11-06', '2026-11-07'])
  })
})
