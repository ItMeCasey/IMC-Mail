// Keeping an OAuth sign-in alive on the phone: when an access token is still good, and how to get a new one
// from the refresh token. The phone stores only the refresh token (in the system keystore); access tokens
// live in memory and are fetched again when needed.

export interface Tokens {
  accessToken: string
  refreshToken: string
  /** Epoch ms when the access token stops working. */
  expiresAt: number
}

/** The refresh token no longer works (revoked, expired, password changed): the person has to sign in again. */
export class ReauthRequired extends Error {
  constructor() {
    super('Sign in again to keep using this account')
  }
}

/** Anything else that went wrong asking for a token: network, server. */
export class TokenError extends Error {}

export interface TokenEndpoint {
  tokenUrl: string
  clientId: string
  /** Microsoft needs the scope again on refresh, because its tokens are for one resource at a time. */
  scope?: string
}

/** Whether the token is still good for a while yet (a minute of margin, so it does not run out mid-request). */
export const isFresh = (t: Pick<Tokens, 'expiresAt'>, now: number, marginMs = 60_000): boolean => t.expiresAt - marginMs > now

/** Exchanges a refresh token for a new access token. The provider may also send a new refresh token; that one is kept. */
export async function refreshTokens(ep: TokenEndpoint, refreshToken: string, fetchFn: typeof fetch = fetch, now: () => number = Date.now): Promise<Tokens> {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: ep.clientId })
  if (ep.scope) body.set('scope', ep.scope)
  let res: Response
  try {
    res = await fetchFn(ep.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: body.toString() })
  } catch {
    throw new TokenError("Can't reach the sign-in server")
  }
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }
  if (!res.ok || !json.access_token) {
    if (json.error === 'invalid_grant') throw new ReauthRequired()
    throw new TokenError(json.error_description ?? json.error ?? `The sign-in server answered ${res.status}`)
  }
  return { accessToken: json.access_token, refreshToken: json.refresh_token ?? refreshToken, expiresAt: now() + (json.expires_in ?? 3600) * 1000 }
}
