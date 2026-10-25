import { describe, expect, it } from 'vitest'
import { guessServers } from './providers'

describe('guessServers', () => {
  it('maps known providers and their aliases', () => {
    expect(guessServers('a@gmail.com')?.imap.host).toBe('imap.gmail.com')
    expect(guessServers('a@googlemail.com')?.provider).toBe('gmail')
    expect(guessServers('a@hotmail.com')?.provider).toBe('microsoft')
    expect(guessServers('a@me.com')?.imap.host).toBe('imap.mail.me.com')
  })

  it('falls back to imap./smtp. on the domain', () => {
    const g = guessServers('me@Example.ORG')
    expect(g?.imap).toEqual({ host: 'imap.example.org', port: 993, security: 'tls' })
    expect(g?.smtp.host).toBe('smtp.example.org')
  })

  it('rejects malformed addresses', () => {
    expect(guessServers('nope')).toBeNull()
    expect(guessServers('@x.com')).toBeNull()
    expect(guessServers('a@')).toBeNull()
  })
})
