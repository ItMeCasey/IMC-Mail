import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { oauthProviders } from '@imc/core'
import {
  challengeFor,
  loadOAuthConfig,
  ReauthRequired,
  signIn,
  TokenProvider,
  waitForAuthCode,
  type OAuthConfig
} from './oauth'
import type { SecretStore } from './secrets'

const memory = (): SecretStore & { data: Map<string, string> } => {
  const data = new Map<string, string>()
  return {
    data,
    get: async (k) => data.get(k),
    set: async (k, v) => void data.set(k, v),
    delete: async (k) => void data.delete(k)
  }
}

const jsonRes = (status: number, body: object) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const idToken = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`

describe('PKCE', () => {
  it('matches the RFC 7636 test vector', () => {
    expect(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    )
  })
})

describe('loadOAuthConfig', () => {
  it('reads oauth.json and lets env vars win', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imc-oauth-'))
    writeFileSync(
      join(dir, 'oauth.json'),
      JSON.stringify({ gmail: { clientId: 'file-g', clientSecret: 's' }, microsoft: { clientId: 'file-m' } })
    )
    expect(loadOAuthConfig(dir, {})).toEqual({
      gmail: { clientId: 'file-g', clientSecret: 's' },
      microsoft: { clientId: 'file-m' }
    })
    expect(loadOAuthConfig(dir, { IMC_MICROSOFT_CLIENT_ID: 'env-m' }).microsoft?.clientId).toBe('env-m')
  })

  it("reads Google's downloaded client file from an extra dir, below oauth.json", () => {
    const userData = mkdtempSync(join(tmpdir(), 'imc-oauth-'))
    const repo = mkdtempSync(join(tmpdir(), 'imc-repo-'))
    writeFileSync(
      join(repo, '.google-oauth.json'),
      JSON.stringify({ installed: { client_id: 'dl-id', client_secret: 'dl-sec' } })
    )
    expect(loadOAuthConfig(userData, {}, [repo]).gmail).toEqual({
      clientId: 'dl-id',
      clientSecret: 'dl-sec'
    })
    writeFileSync(join(userData, 'oauth.json'), JSON.stringify({ gmail: { clientId: 'mine' } }))
    expect(loadOAuthConfig(userData, {}, [repo]).gmail?.clientId).toBe('mine')
  })

  it('is empty when nothing is configured or the file is broken', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imc-oauth-'))
    expect(loadOAuthConfig(dir, {})).toEqual({})
    writeFileSync(join(dir, 'oauth.json'), '{not json')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(loadOAuthConfig(dir, {})).toEqual({})
  })
})

describe('waitForAuthCode', () => {
  const run = (hit: (redirect: string) => Promise<void>, extra: { timeoutMs?: number; signal?: AbortSignal } = {}) =>
    waitForAuthCode({
      host: '127.0.0.1',
      expectedState: 'good',
      timeoutMs: extra.timeoutMs ?? 5000,
      signal: extra.signal,
      buildUrl: (redirect) => `https://provider.test/auth?redirect_uri=${encodeURIComponent(redirect)}`,
      openUrl: (url) => {
        const redirect = new URL(url).searchParams.get('redirect_uri')!
        void hit(redirect)
      }
    })

  it('resolves with the code, ignoring requests with a wrong state', async () => {
    const result = await run(async (r) => {
      const forged = await fetch(`${r}?code=evil&state=bad`)
      expect(forged.status).toBe(400)
      await fetch(`${r}?code=abc123&state=good`)
    })
    expect(result.code).toBe('abc123')
    expect(result.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
  })

  it('rejects when the provider reports an error', async () => {
    await expect(run((r) => fetch(`${r}?error=access_denied&state=good`).then(() => {}))).rejects.toThrow(
      /access_denied/
    )
  })

  it('times out', async () => {
    await expect(run(async () => {}, { timeoutMs: 50 })).rejects.toThrow(/timed out/)
  })

  it('can be cancelled', async () => {
    const ac = new AbortController()
    const p = run(async () => ac.abort(), { signal: ac.signal })
    await expect(p).rejects.toThrow(/cancelled/)
  })
})

describe('signIn', () => {
  it('runs the PKCE exchange and returns identity + tokens', async () => {
    const calls: URLSearchParams[] = []
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init?.body as URLSearchParams)
      return jsonRes(200, {
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 3600,
        id_token: idToken({ email: 'me@gmail.com', name: 'Me' })
      })
    })
    let challenge = ''
    const result = await signIn(
      oauthProviders.gmail,
      { clientId: 'cid', clientSecret: 'sec' },
      {
        fetchFn: fetchFn as unknown as typeof fetch,
        now: () => 1_000,
        openUrl: (url) => {
          const q = new URL(url).searchParams
          challenge = q.get('code_challenge')!
          void fetch(`${q.get('redirect_uri')}?code=thecode&state=${q.get('state')}`)
        }
      }
    )
    expect(result).toEqual({
      email: 'me@gmail.com',
      name: 'Me',
      tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: 1_000 + 3_600_000 }
    })
    const body = calls[0]!
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('thecode')
    expect(body.get('client_secret')).toBe('sec')
    // The verifier sent to the token endpoint must hash to the challenge sent to the browser.
    expect(challengeFor(body.get('code_verifier')!)).toBe(challenge)
  })

  it('does not send a client secret for Microsoft', async () => {
    const fetchFn = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      expect((init?.body as URLSearchParams).has('client_secret')).toBe(false)
      return jsonRes(200, {
        access_token: 'at',
        refresh_token: 'rt',
        id_token: idToken({ preferred_username: 'me@outlook.com' })
      })
    })
    const r = await signIn(
      oauthProviders.microsoft,
      { clientId: 'cid', clientSecret: 'ignored' },
      {
        fetchFn: fetchFn as unknown as typeof fetch,
        openUrl: (url) => {
          const q = new URL(url).searchParams
          void fetch(`${q.get('redirect_uri')}?code=c&state=${q.get('state')}`)
        }
      }
    )
    expect(r.email).toBe('me@outlook.com')
  })

  it('fails clearly when no refresh token comes back', async () => {
    const fetchFn = async () => jsonRes(200, { access_token: 'at', id_token: idToken({ email: 'a@b.c' }) })
    await expect(
      signIn(
        oauthProviders.gmail,
        { clientId: 'c' },
        {
          fetchFn: fetchFn as unknown as typeof fetch,
          openUrl: (url) => {
            const q = new URL(url).searchParams
            void fetch(`${q.get('redirect_uri')}?code=c&state=${q.get('state')}`)
          }
        }
      )
    ).rejects.toThrow(/refresh token/)
  })
})

describe('TokenProvider', () => {
  const config: OAuthConfig = { gmail: { clientId: 'cid', clientSecret: 'sec' } }
  const setup = (fetchFn: typeof fetch, now = 10_000_000) => {
    const secrets = memory()
    const tp = new TokenProvider(secrets, config, () => oauthProviders.gmail, fetchFn, () => now)
    return { secrets, tp }
  }

  it('returns a still-valid token without touching the network', async () => {
    const fetchFn = vi.fn()
    const { tp } = setup(fetchFn as unknown as typeof fetch)
    await tp.save('a1', { accessToken: 'live', refreshToken: 'r', expiresAt: 10_000_000 + 600_000 })
    expect(await tp.getAccessToken('a1')).toBe('live')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('refreshes an expired token, persists rotation, and dedupes concurrent calls', async () => {
    const fetchFn = vi.fn(async () =>
      jsonRes(200, { access_token: 'fresh', refresh_token: 'rotated', expires_in: 3600 })
    )
    const { tp, secrets } = setup(fetchFn as unknown as typeof fetch)
    await tp.save('a1', { accessToken: 'old', refreshToken: 'r', expiresAt: 1 })

    const [x, y] = await Promise.all([tp.getAccessToken('a1'), tp.getAccessToken('a1')])
    expect([x, y]).toEqual(['fresh', 'fresh'])
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(JSON.parse(secrets.data.get('oauth:a1')!)).toMatchObject({
      accessToken: 'fresh',
      refreshToken: 'rotated'
    })
  })

  it('keeps the old refresh token when the provider does not rotate it', async () => {
    const fetchFn = async () => jsonRes(200, { access_token: 'fresh', expires_in: 60 })
    const { tp, secrets } = setup(fetchFn as unknown as typeof fetch)
    await tp.save('a1', { accessToken: 'old', refreshToken: 'keep', expiresAt: 1 })
    await tp.getAccessToken('a1')
    expect(JSON.parse(secrets.data.get('oauth:a1')!).refreshToken).toBe('keep')
  })

  it('asks for re-auth on invalid_grant or missing tokens', async () => {
    const fetchFn = async () => jsonRes(400, { error: 'invalid_grant' })
    const { tp } = setup(fetchFn as unknown as typeof fetch)
    await expect(tp.getAccessToken('nobody')).rejects.toBeInstanceOf(ReauthRequired)
    await tp.save('a1', { accessToken: 'old', refreshToken: 'dead', expiresAt: 1 })
    await expect(tp.getAccessToken('a1')).rejects.toBeInstanceOf(ReauthRequired)
  })

  it('surfaces other token errors with the provider message', async () => {
    const fetchFn = async () => jsonRes(401, { error: 'invalid_client', error_description: 'bad secret' })
    const { tp } = setup(fetchFn as unknown as typeof fetch)
    await tp.save('a1', { accessToken: 'old', refreshToken: 'r', expiresAt: 1 })
    await expect(tp.getAccessToken('a1')).rejects.toThrow(/bad secret/)
  })
})
