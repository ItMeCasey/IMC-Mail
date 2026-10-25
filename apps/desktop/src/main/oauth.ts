import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import {
  buildAuthUrl,
  decodeJwtPayload,
  identityFromClaims,
  type OAuthProviderDef,
  type OAuthProviderId
} from '@imc/core'
import type { SecretStore } from './secrets'

export interface OAuthClient {
  clientId: string
  clientSecret?: string
}
export type OAuthConfig = Partial<Record<OAuthProviderId, OAuthClient>>

/** Thrown when the refresh token is no longer valid and the user must sign in again. */
export class ReauthRequired extends Error {
  constructor() {
    super('Sign-in expired. Remove the account and add it again.')
  }
}

/**
 * Client IDs come from `<userData>/oauth.json` or IMC_* env vars (env wins), so they never
 * live in source control. See docs/oauth-setup.md.
 */
function readJson(path: string): Record<string, any> | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    console.error(`[oauth] ${path} is not valid JSON, ignoring`)
    return null
  }
}

/**
 * Precedence: env vars, then `<userData>/oauth.json`, then Google's downloaded client file
 * `.google-oauth.json` (looked up in userData and in `extraDirs`, e.g. the repo root in dev).
 */
export function loadOAuthConfig(
  userDataDir: string,
  env: NodeJS.ProcessEnv = process.env,
  extraDirs: string[] = []
): OAuthConfig {
  const file: { gmail?: Partial<OAuthClient>; microsoft?: Partial<OAuthClient> } =
    readJson(join(userDataDir, 'oauth.json')) ?? {}

  // The JSON you download from Google Cloud wraps the keys in "installed" (or "web").
  for (const dir of [userDataDir, ...extraDirs]) {
    const g = readJson(join(dir, '.google-oauth.json'))
    const c = g?.installed ?? g?.web
    if (c?.client_id) {
      file.gmail ??= { clientId: c.client_id, clientSecret: c.client_secret }
      break
    }
  }

  const out: OAuthConfig = {}
  const gId = env['IMC_GOOGLE_CLIENT_ID'] ?? file.gmail?.clientId
  const gSecret = env['IMC_GOOGLE_CLIENT_SECRET'] ?? file.gmail?.clientSecret
  if (gId) out.gmail = { clientId: gId, clientSecret: gSecret }
  const mId = env['IMC_MICROSOFT_CLIENT_ID'] ?? file.microsoft?.clientId
  if (mId) out.microsoft = { clientId: mId }
  return out
}

// ---- PKCE -----------------------------------------------------------------

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: challengeFor(verifier) }
}

export const challengeFor = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url')

// ---- Loopback redirect ------------------------------------------------------

const page = (res: ServerResponse, status: number, title: string, body: string, then?: () => void) => {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(
    `<!doctype html><meta charset="utf-8"><title>IMC-Mail</title>
<body style="font:16px system-ui;background:#0b0b0f;color:#e7e7ee;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1>${title}</h1><p>${body}</p></div>`,
    then
  )
}

/**
 * Starts a one-shot loopback server, hands its redirect URI to `openUrl`, and resolves with the
 * authorization code once the browser comes back with a matching `state`.
 */
export function waitForAuthCode(o: {
  host: string
  expectedState: string
  buildUrl: (redirectUri: string) => string
  /** Path to put on the redirect URI; '' for none. Defaults to /callback. */
  path?: string
  openUrl: (url: string) => void | Promise<void>
  timeoutMs: number
  signal?: AbortSignal
}): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    let done = false
    let redirectUri = ''

    const finish = (fn: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      o.signal?.removeEventListener('abort', onAbort)
      server.close()
      server.closeIdleConnections()
      fn()
    }
    const onAbort = () => finish(() => reject(new Error('Sign-in cancelled')))
    const timer = setTimeout(
      () => finish(() => reject(new Error('Sign-in timed out'))),
      o.timeoutMs
    )
    if (o.signal?.aborted) return onAbort()
    o.signal?.addEventListener('abort', onAbort)

    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      // Providers that register the redirect without a path send the browser back to "/".
      if (url.pathname !== '/callback' && url.pathname !== '/') {
        res.writeHead(404).end()
        return
      }
      // A request without our state is noise or a forgery: answer it, but keep waiting.
      if (url.searchParams.get('state') !== o.expectedState) {
        page(res, 400, 'Invalid request', 'This sign-in link does not belong to IMC-Mail.')
        return
      }
      const error = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      if (error || !code) {
        page(res, 400, 'Sign-in failed', 'You can close this tab and try again.', () =>
          finish(() => reject(new Error(`Sign-in denied${error ? `: ${error}` : ''}`)))
        )
        return
      }
      page(res, 200, 'Signed in', 'You can close this tab and return to IMC-Mail.', () =>
        finish(() => resolve({ code, redirectUri }))
      )
    })
    server.once('error', (e) => finish(() => reject(e)))
    server.listen(0, o.host, () => {
      redirectUri = `http://${o.host}:${(server.address() as AddressInfo).port}${o.path ?? '/callback'}`
      Promise.resolve(o.openUrl(o.buildUrl(redirectUri))).catch((e) => finish(() => reject(e)))
    })
  })
}

// ---- Token endpoint ---------------------------------------------------------

export interface Tokens {
  accessToken: string
  refreshToken: string
  /** Epoch ms. */
  expiresAt: number
}

type FetchFn = typeof fetch

async function requestToken(
  def: OAuthProviderDef,
  client: OAuthClient,
  params: Record<string, string>,
  fetchFn: FetchFn,
  now: () => number
): Promise<{ accessToken: string; refreshToken?: string; expiresAt: number; idToken?: string }> {
  const body = new URLSearchParams({ client_id: client.clientId, ...params })
  if (def.usesClientSecret && client.clientSecret) body.set('client_secret', client.clientSecret)

  const res = await fetchFn(def.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body
  })
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    id_token?: string
    error?: string
    error_description?: string
  }
  if (!res.ok || !json.access_token) {
    if (json.error === 'invalid_grant') throw new ReauthRequired()
    throw new Error(
      `Token request failed: ${json.error_description ?? json.error ?? `HTTP ${res.status}`}`
    )
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: now() + (json.expires_in ?? 3600) * 1000,
    idToken: json.id_token
  }
}

export interface SignInResult {
  tokens: Tokens
  email: string
  name: string
}

/** Full authorization-code + PKCE flow through the system browser. */
export async function signIn(
  def: OAuthProviderDef,
  client: OAuthClient,
  o: {
    openUrl: (url: string) => void | Promise<void>
    signal?: AbortSignal
    timeoutMs?: number
    fetchFn?: FetchFn
    now?: () => number
  }
): Promise<SignInResult> {
  const fetchFn = o.fetchFn ?? fetch
  const now = o.now ?? Date.now
  const { verifier, challenge } = createPkce()
  const state = randomBytes(16).toString('base64url')

  const { code, redirectUri } = await waitForAuthCode({
    host: def.loopbackHost,
    path: def.redirectPath,
    expectedState: state,
    timeoutMs: o.timeoutMs ?? 5 * 60_000,
    signal: o.signal,
    openUrl: o.openUrl,
    buildUrl: (redirectUri) =>
      buildAuthUrl(def, { clientId: client.clientId, redirectUri, state, challenge })
  })

  const t = await requestToken(
    def,
    client,
    { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier },
    fetchFn,
    now
  )
  if (!t.refreshToken) {
    throw new Error('The provider did not return a refresh token. Revoke IMC-Mail access and retry.')
  }
  const { email, name } = identityFromClaims(t.idToken ? decodeJwtPayload(t.idToken) : {})
  if (!email) throw new Error('Could not read your email address from the sign-in response')
  return {
    tokens: { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt },
    email,
    name
  }
}

// ---- Token storage and refresh ----------------------------------------------

const REFRESH_SKEW_MS = 60_000

/** Hands out fresh access tokens, refreshing (and persisting rotated tokens) when needed. */
export class TokenProvider {
  private inflight = new Map<string, Promise<string>>()

  constructor(
    private secrets: SecretStore,
    private config: OAuthConfig,
    private providerFor: (accountId: string) => OAuthProviderDef | undefined,
    private fetchFn: FetchFn = fetch,
    private now: () => number = Date.now
  ) {}

  private key = (accountId: string) => `oauth:${accountId}`

  async save(accountId: string, tokens: Tokens): Promise<void> {
    await this.secrets.set(this.key(accountId), JSON.stringify(tokens))
  }

  async delete(accountId: string): Promise<void> {
    await this.secrets.delete(this.key(accountId))
  }

  getAccessToken(accountId: string): Promise<string> {
    let p = this.inflight.get(accountId)
    if (!p) {
      p = this.load(accountId).finally(() => this.inflight.delete(accountId))
      this.inflight.set(accountId, p)
    }
    return p
  }

  private async load(accountId: string): Promise<string> {
    const raw = await this.secrets.get(this.key(accountId))
    if (!raw) throw new ReauthRequired()
    const tokens = JSON.parse(raw) as Tokens
    if (tokens.expiresAt - REFRESH_SKEW_MS > this.now()) return tokens.accessToken

    const def = this.providerFor(accountId)
    const client = def && this.config[def.id]
    if (!def || !client) {
      throw new Error('OAuth client is not configured on this machine (see docs/oauth-setup.md)')
    }
    const t = await requestToken(
      def,
      client,
      { grant_type: 'refresh_token', refresh_token: tokens.refreshToken },
      this.fetchFn,
      this.now
    )
    await this.save(accountId, {
      accessToken: t.accessToken,
      // Providers may rotate the refresh token; keep the old one when they don't.
      refreshToken: t.refreshToken ?? tokens.refreshToken,
      expiresAt: t.expiresAt
    })
    return t.accessToken
  }
}
