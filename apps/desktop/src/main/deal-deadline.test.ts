import { describe, expect, it } from 'vitest'
import { bodyText, dealDeadlineFromEmail } from './deal-deadline'

const NOW = new Date(2026, 9, 21, 10)

describe('deal deadline from email', () => {
  it('fills the soonest upcoming deadline and says where it came from', () => {
    const r = dealDeadlineFromEmail('Sponsorship brief', { text: 'Script is due Nov 10, video live by 11/20.', html: null }, NOW)
    expect(r).toEqual({ dueDate: new Date(2026, 10, 10).getTime(), note: 'Due date taken from the email: "due Nov 10".' })
  })
  it('reads HTML-only mail, ignoring style blocks and tags', () => {
    const html = '<style>.x{color:red}</style><p>Please deliver</p><p>by <b>December 1</b></p>'
    expect(bodyText({ text: '', html })).not.toContain('color')
    expect(dealDeadlineFromEmail('', { text: '', html }, NOW)?.dueDate).toBe(new Date(2026, 11, 1).getTime())
  })
  it('returns nothing when no deadline is asked for', () => {
    expect(dealDeadlineFromEmail('Hello', { text: 'We loved your last stream.', html: null }, NOW)).toBeNull()
    expect(dealDeadlineFromEmail('Hello', undefined, NOW)).toBeNull()
  })
})
