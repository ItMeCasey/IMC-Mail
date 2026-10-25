import { describe, expect, it } from 'vitest'
import { cleanFolderName, PROTECTED_ROLES } from './folders'

describe('cleanFolderName', () => {
  it('trims and tidies spaces', () => expect(cleanFolderName('  Brand   Deals ')).toEqual({ ok: true, name: 'Brand Deals' }))
  it('allows an inner dot', () => expect(cleanFolderName('v1.2 notes')).toEqual({ ok: true, name: 'v1.2 notes' }))
  it.each([
    ['', /name/],
    ['   ', /name/],
    ['a/b', /cannot contain/],
    ['a\\b', /cannot contain/],
    ['x'.repeat(101), /100/],
    ['bad\u0007name', /characters/],
    ['.hidden', /dot/],
    ['trailing.', /dot/],
    ['INBOX', /Inbox/]
  ])('refuses %j', (raw, why) => {
    const r = cleanFolderName(raw)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(why)
  })
  it('protects the standard roles', () => expect(PROTECTED_ROLES).toContain('trash'))
})
