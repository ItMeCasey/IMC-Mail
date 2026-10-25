import { describe, expect, it } from 'vitest'
import { findDeadlines, nextDeadline } from './deadlines'

const NOW = new Date(2026, 9, 21, 10, 0) // Wednesday Oct 21, 2026
const day = (m: number, d: number, y = 2026) => new Date(y, m, d).getTime()
const dates = (t: string, now = NOW) => findDeadlines(t, now).map((d) => d.date)

describe('findDeadlines', () => {
  it('reads month-name dates after a cue, with ordinals and optional years', () => {
    expect(dates('Please send the draft by November 15th.')).toEqual([day(10, 15)])
    expect(dates('Deadline: Nov 3, 2027')).toEqual([day(10, 3, 2027)])
    expect(dates('due on 9 December')).toEqual([day(11, 9)])
    expect(dates('delivered by the 30th of Nov')).toEqual([day(10, 30)])
  })

  it('reads numeric dates month-first, and ignores nonsense', () => {
    expect(dates('submit by 11/15')).toEqual([day(10, 15)])
    expect(dates('due 11/15/26')).toEqual([day(10, 15)])
    expect(dates('due 31/12')).toEqual([])
    expect(dates('by Feb 30')).toEqual([])
  })

  it('reads weekdays as the next one and "within N days" from today', () => {
    expect(dates('Need it by Friday')).toEqual([day(9, 23)])
    expect(dates('no later than end of day Wednesday')).toEqual([day(9, 28)]) // today is Wednesday: next week
    expect(dates('Please post within 10 days')).toEqual([day(9, 31)])
    expect(dates('within 2 weeks')).toEqual([day(10, 4)])
  })

  it('needs a cue: a bare date is not a deadline', () => {
    expect(dates('We spoke on March 3 about the offer.')).toEqual([])
    expect(dates('Our Q4 starts October 1')).toEqual([])
  })

  it('rolls a date with no year into next year once it is well past', () => {
    expect(dates('by January 10', NOW)).toEqual([day(0, 10, 2027)])
    expect(dates('by October 15', NOW)).toEqual([day(9, 15)]) // a few days ago: still this year
  })

  it('finds several, sorted and without duplicates, and keeps the wording', () => {
    const found = findDeadlines('Script due Nov 10. Video live by 11/20. Reminder: due Nov 10.', NOW)
    expect(found.map((f) => f.date)).toEqual([day(10, 10), day(10, 20)])
    expect(found[0]!.phrase).toBe('due Nov 10')
  })
})

describe('nextDeadline', () => {
  it('picks the soonest one that has not passed', () => {
    expect(nextDeadline('by October 15 and by November 2', NOW)?.date).toBe(day(10, 2))
    expect(nextDeadline('nothing here', NOW)).toBeNull()
  })
})
