import { describe, expect, it } from 'vitest'
import { logoDomain } from './logo'

describe('logoDomain', () => {
  it('uses the company domain, not the mailing subdomain', () => {
    expect(logoDomain('no-reply@spotify.com')).toBe('spotify.com')
    expect(logoDomain('news@email.spotify.com')).toBe('spotify.com')
    expect(logoDomain('Billing <a@b.mail.uber.com>'.replace(/^.*</, '').replace('>', ''))).toBe('uber.com')
  })

  it('keeps the extra label under a country second level', () => {
    expect(logoDomain('hello@shop.example.co.uk')).toBe('example.co.uk')
    expect(logoDomain('x@mail.company.com.au')).toBe('company.com.au')
  })

  it('shows nothing for personal mailboxes and unusable addresses', () => {
    for (const a of ['me@gmail.com', 'x@Hotmail.com', 'x@outlook.com', 'x@icloud.com', 'nobody', 'x@localhost', 'x@bad domain.com', '', null, undefined]) expect(logoDomain(a)).toBeNull()
  })
})
