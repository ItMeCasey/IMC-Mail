import { describe, expect, it, vi } from 'vitest'
import { isFresh, ReauthRequired, refreshTokens, TokenError } from './oauth-tokens'

const reply = (status: number, json: unknown) => vi.fn(async () => new Response(JSON.stringify(json), { status }))
const ep = { tokenUrl: 'https://login.example/token', clientId: 'cid' }

describe('refreshing tokens', () => {
  it('gets a new access token and says when it runs out', async () => {
    const f = reply(200, { access_token: 'at2', expires_in: 1800 })
    const t = await refreshTokens(ep, 'rt1', f as unknown as typeof fetch, () => 1_000)
    expect(t).toEqual({ accessToken: 'at2', refreshToken: 'rt1', expiresAt: 1_000 + 1800_000 })
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(ep.tokenUrl)
    const body = new URLSearchParams(String(init.body))
    expect(Object.fromEntries(body)).toEqual({ grant_type: 'refresh_token', refresh_token: 'rt1', client_id: 'cid' })
  })

  it('keeps a new refresh token when the provider rotates it', async () => {
    const t = await refreshTokens(ep, 'old', reply(200, { access_token: 'a', refresh_token: 'new' }) as unknown as typeof fetch)
    expect(t.refreshToken).toBe('new')
  })

  it('sends the scope when the provider needs it', async () => {
    const f = reply(200, { access_token: 'a' })
    await refreshTokens({ ...ep, scope: 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access' }, 'rt', f as unknown as typeof fetch)
    const body = new URLSearchParams(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(body.get('scope')).toContain('IMAP.AccessAsUser.All')
  })

  it('asks for a new sign-in when the refresh token was revoked', async () => {
    await expect(refreshTokens(ep, 'rt', reply(400, { error: 'invalid_grant' }) as unknown as typeof fetch)).rejects.toBeInstanceOf(ReauthRequired)
  })

  it('tells other failures apart from a revoked sign-in', async () => {
    await expect(refreshTokens(ep, 'rt', reply(500, { error: 'server_error', error_description: 'Try later' }) as unknown as typeof fetch)).rejects.toThrow('Try later')
    await expect(refreshTokens(ep, 'rt', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch)).rejects.toBeInstanceOf(TokenError)
    await expect(refreshTokens(ep, 'rt', reply(200, {}) as unknown as typeof fetch)).rejects.toBeInstanceOf(TokenError)
  })
})

describe('when a token is still good', () => {
  it('leaves a minute of margin', () => {
    expect(isFresh({ expiresAt: 100_000 }, 30_000)).toBe(true)
    expect(isFresh({ expiresAt: 100_000 }, 45_000)).toBe(false)
    expect(isFresh({ expiresAt: 100_000 }, 99_000)).toBe(false)
  })
})
