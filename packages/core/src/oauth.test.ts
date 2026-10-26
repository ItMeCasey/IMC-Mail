import { describe, expect, it } from 'vitest'
import { buildAuthUrl, decodeJwtPayload, identityFromClaims, oauthProviders } from './oauth'

const b64url = (s: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

const jwt = (claims: object) => `h.${b64url(JSON.stringify(claims))}.s`

describe('buildAuthUrl', () => {
  it('includes PKCE S256 and provider extras for Google', () => {
    const u = new URL(
      buildAuthUrl(oauthProviders.gmail, {
        clientId: 'cid',
        redirectUri: 'http://127.0.0.1:5555/callback',
        state: 'st',
        challenge: 'ch'
      })
    )
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    const q = u.searchParams
    expect(q.get('code_challenge')).toBe('ch')
    expect(q.get('code_challenge_method')).toBe('S256')
    expect(q.get('response_type')).toBe('code')
    expect(q.get('access_type')).toBe('offline')
    expect(q.get('scope')).toContain('https://mail.google.com/')
    expect(q.get('redirect_uri')).toBe('http://127.0.0.1:5555/callback')
  })

  it('adds read access to the calendar only when asked, and can name the account', () => {
    const base = { clientId: 'cid', redirectUri: 'http://localhost:1', state: 's', challenge: 'c' }
    const without = new URL(buildAuthUrl(oauthProviders.microsoft, base)).searchParams
    expect(without.get('scope')).not.toContain('Calendars')
    expect(without.get('login_hint')).toBeNull()
    const ms = new URL(buildAuthUrl(oauthProviders.microsoft, { ...base, calendar: true, loginHint: 'a@hotmail.com' })).searchParams
    expect(ms.get('scope')).toContain('https://graph.microsoft.com/Calendars.Read')
    expect(ms.get('scope')).toContain('IMAP.AccessAsUser.All')
    expect(ms.get('login_hint')).toBe('a@hotmail.com')
    const g = new URL(buildAuthUrl(oauthProviders.gmail, { ...base, calendar: true })).searchParams
    expect(g.get('scope')).toContain('https://www.googleapis.com/auth/calendar.readonly')
  })

  it('asks Microsoft for offline_access and IMAP scopes', () => {
    const u = new URL(
      buildAuthUrl(oauthProviders.microsoft, {
        clientId: 'cid',
        redirectUri: 'http://localhost:1/callback',
        state: 's',
        challenge: 'c'
      })
    )
    const scope = u.searchParams.get('scope') ?? ''
    expect(scope).toContain('offline_access')
    expect(scope).toContain('IMAP.AccessAsUser.All')
  })
})

describe('id_token helpers', () => {
  it('decodes unicode claims', () => {
    expect(decodeJwtPayload(jwt({ name: 'Zoë ✓' })).name).toBe('Zoë ✓')
  })

  it('prefers email, falls back to preferred_username, rejects non-emails', () => {
    expect(identityFromClaims({ email: 'a@x.com', name: 'A' })).toEqual({ email: 'a@x.com', name: 'A' })
    expect(identityFromClaims({ preferred_username: 'b@y.com' }).email).toBe('b@y.com')
    expect(identityFromClaims({ preferred_username: 'not-an-email' }).email).toBeNull()
  })

  it('rejects a malformed token', () => {
    expect(() => decodeJwtPayload('nope')).toThrow()
  })
})

describe('redirect paths', () => {
  it('Microsoft uses none (its registration is a bare http://localhost); Google keeps /callback', () => {
    expect(oauthProviders.microsoft.redirectPath).toBe('')
    expect(oauthProviders.microsoft.loopbackHost).toBe('localhost')
    expect(oauthProviders.gmail.redirectPath).toBe('/callback')
  })
})
