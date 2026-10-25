import { describe, expect, it } from 'vitest'
import { matchesRule, ruleHasConditions } from './rules'

const msg = { fromName: 'Nova Energy', fromAddr: 'partners@nova.example', to: 'me@x.example', subject: 'Q4 sponsorship brief', snippet: 'Rate is four thousand' }
const none = { from: '', to: '', subject: '', contains: '' }

describe('matchesRule', () => {
  it('matches each field case-insensitively, and all filled fields must match', () => {
    expect(matchesRule({ ...none, from: 'NOVA' }, msg)).toBe(true)
    expect(matchesRule({ ...none, from: 'nova.example', subject: 'brief' }, msg)).toBe(true)
    expect(matchesRule({ ...none, from: 'nova', subject: 'invoice' }, msg)).toBe(false)
    expect(matchesRule({ ...none, to: 'me@x' }, msg)).toBe(true)
    expect(matchesRule({ ...none, contains: 'four thousand' }, msg)).toBe(true)
    expect(matchesRule({ ...none, contains: 'sponsorship' }, msg)).toBe(true)
  })
  it('never matches a rule with no conditions, or only blanks', () => {
    expect(ruleHasConditions(none)).toBe(false)
    expect(matchesRule(none, msg)).toBe(false)
    expect(matchesRule({ ...none, from: '   ' }, msg)).toBe(false)
  })
})
