import { describe, expect, it } from 'vitest'
import { followUpPresets, fromLocalInput, schedulePresets, snoozePresets, toLocalInput } from './schedule'

const labels = (now: Date) => schedulePresets(now).map((p) => new Date(p.at).getDay() + '@' + new Date(p.at).getHours())

describe('schedulePresets', () => {
  it('offers later today, tomorrow morning, and Monday', () => {
    // Wednesday 10:00
    const p = schedulePresets(new Date(2026, 9, 21, 10, 0))
    expect(p).toHaveLength(3)
    expect(labels(new Date(2026, 9, 21, 10, 0))).toEqual(['3@18', '4@8', '1@8'])
    expect(p.every((x) => x.at > new Date(2026, 9, 21, 10, 0).getTime())).toBe(true)
  })

  it('drops "later today" once it is within an hour of 6pm or past it', () => {
    expect(labels(new Date(2026, 9, 21, 17, 30))[0]).toBe('4@8')
    expect(labels(new Date(2026, 9, 21, 21, 0))[0]).toBe('4@8')
  })

  it('does not offer Monday when tomorrow already is Monday', () => {
    // Sunday: tomorrow is Monday
    const p = labels(new Date(2026, 9, 25, 10, 0))
    expect(p).toEqual(['0@18', '1@8'])
  })

  it('on Friday, Monday is three days away and is offered', () => {
    expect(labels(new Date(2026, 9, 23, 20, 0))).toEqual(['6@8', '1@8'])
  })
})

describe('local datetime input', () => {
  it('round-trips', () => {
    const t = new Date(2026, 10, 3, 9, 5).getTime()
    expect(toLocalInput(t)).toBe('2026-11-03T09:05')
    expect(fromLocalInput('2026-11-03T09:05')).toBe(t)
  })
  it('rejects empty or malformed values', () => {
    expect(fromLocalInput('')).toBeNull()
    expect(fromLocalInput('2026-11-03')).toBeNull()
    expect(fromLocalInput('nonsense')).toBeNull()
  })
})

describe('snoozePresets', () => {
  const days = (now: Date) => snoozePresets(now).map((p) => new Date(p.at).getDay() + '@' + new Date(p.at).getHours())
  it('offers today, tomorrow, the weekend, and next week from midweek', () => {
    expect(days(new Date(2026, 9, 21, 10, 0))).toEqual(['3@18', '4@8', '6@9', '1@8'])
  })
  it('skips the weekend on Saturday and Sunday, and a Monday that is tomorrow', () => {
    expect(days(new Date(2026, 9, 24, 10, 0))).toEqual(['6@18', '0@8', '1@8']) // Saturday
    expect(days(new Date(2026, 9, 25, 20, 0))).toEqual(['1@8']) // Sunday evening: tomorrow is Monday
  })
})

describe('followUpPresets', () => {
  it('offers 2 days, 3 days, 1 week and 2 weeks out, at 9 in the morning', () => {
    const now = new Date(2026, 9, 21, 15, 30)
    const p = followUpPresets(now)
    expect(p.map((x) => Math.round((new Date(x.at).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000))).toEqual([2, 3, 7, 14])
    expect(p.every((x) => new Date(x.at).getHours() === 9)).toBe(true)
  })
})
