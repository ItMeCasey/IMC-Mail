import { describe, expect, it } from 'vitest'
import { defaultHolidayCountry, holidayCountries, holidaysBetween } from './holidays'

const day = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime()

describe('holidays', () => {
  it('lists countries by name', () => {
    const list = holidayCountries()
    expect(list.find((c) => c.code === 'US')?.name).toMatch(/United States/)
    expect(list.length).toBeGreaterThan(100)
    expect(list.map((c) => c.name)).toEqual([...list.map((c) => c.name)].sort((a, b) => a.localeCompare(b)))
  })

  it('returns the public holidays inside the range only', () => {
    const july = holidaysBetween('US', day(2025, 7, 1), day(2025, 8, 1))
    expect(july).toEqual([{ date: '2025-07-04', name: expect.stringMatching(/Independence/) }])
    expect(holidaysBetween('US', day(2025, 7, 5), day(2025, 8, 1))).toEqual([])
  })

  it('leaves out observances that are not days off', () => {
    const feb = holidaysBetween('US', day(2026, 2, 1), day(2026, 3, 1))
    expect(feb.map((h) => h.name)).not.toContain("Valentine's Day")
  })

  it('covers a range that crosses the new year', () => {
    const r = holidaysBetween('US', day(2026, 12, 20), day(2027, 1, 5))
    expect(r.map((h) => h.date)).toEqual(expect.arrayContaining(['2026-12-25', '2027-01-01']))
  })

  it('differs by country', () => {
    const us = holidaysBetween('US', day(2026, 1, 1), day(2027, 1, 1)).map((h) => h.name)
    const gb = holidaysBetween('GB', day(2026, 1, 1), day(2027, 1, 1)).map((h) => h.name)
    expect(us).not.toEqual(gb)
    expect(gb.join(' ')).toMatch(/Boxing Day/)
  })

  it('reads the country from the system language', () => {
    expect(defaultHolidayCountry('en-GB')).toBe('GB')
    expect(defaultHolidayCountry('de-DE')).toBe('DE')
    expect(defaultHolidayCountry('en')).toBe('US')
    expect(defaultHolidayCountry('xx-ZZ')).toBe('US')
  })
})
