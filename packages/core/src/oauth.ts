import type { ServerConfig } from './schemas'

export type OAuthProviderId = 'gmail' | 'microsoft'

export interface OAuthProviderDef {
  id: OAuthProviderId
  label: string
  authorizeUrl: string
  tokenUrl: string
  scopes: string[]
  /** Read access to the account's calendar, asked for at sign-in or later. Microsoft needs another resource (Graph). */
  calendarScopes: string[]
  /** Host used in the loopback redirect URI; each provider only accepts its own spelling. */
  loopbackHost: '127.0.0.1' | 'localhost'
  /**
   * Path on the loopback redirect URI. Microsoft ignores the port but compares the path, and the
   * registration is `http://localhost` with none, so it must be empty there. Google takes any path.
   */
  redirectPath: '/callback' | ''
  /** Extra query params on the authorize request (offline access, consent behaviour). */
  authParams: Record<string, string>
  /** Google "Desktop app" clients still require a (non-secret) client secret on the token call. */
  usesClientSecret: boolean
  imap: ServerConfig
  smtp: ServerConfig
}

export const oauthProviders: Record<OAuthProviderId, OAuthProviderDef> = {
  gmail: {
    id: 'gmail',
    label: 'Google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://mail.google.com/', 'openid', 'email', 'profile'],
    calendarScopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    loopbackHost: '127.0.0.1',
    redirectPath: '/callback',
    authParams: { access_type: 'offline', prompt: 'consent' },
    usesClientSecret: true,
    imap: { host: 'imap.gmail.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' }
  },
  microsoft: {
    id: 'microsoft',
    label: 'Microsoft',
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: [
      'https://outlook.office.com/IMAP.AccessAsUser.All',
      'https://outlook.office.com/SMTP.Send',
      'offline_access',
      'openid',
      'email',
      'profile'
    ],
    calendarScopes: ['https://graph.microsoft.com/Calendars.Read'],
    loopbackHost: 'localhost',
    redirectPath: '',
    authParams: { prompt: 'select_account' },
    usesClientSecret: false,
    imap: { host: 'outlook.office365.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.office365.com', port: 587, security: 'starttls' }
  }
}

export function buildAuthUrl(
  def: OAuthProviderDef,
  p: { clientId: string; redirectUri: string; state: string; challenge: string; calendar?: boolean; loginHint?: string }
): string {
  const url = new URL(def.authorizeUrl)
  const q = url.searchParams
  q.set('client_id', p.clientId)
  q.set('redirect_uri', p.redirectUri)
  q.set('response_type', 'code')
  q.set('scope', (p.calendar ? [...def.scopes, ...def.calendarScopes] : def.scopes).join(' '))
  if (p.loginHint) q.set('login_hint', p.loginHint)
  q.set('state', p.state)
  q.set('code_challenge', p.challenge)
  q.set('code_challenge_method', 'S256')
  for (const [k, v] of Object.entries(def.authParams)) q.set(k, v)
  return url.toString()
}

/**
 * Reads a JWT payload WITHOUT verifying the signature. Only use on an id_token received
 * directly from the provider's token endpoint over TLS, to learn who just signed in.
 */
export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split('.')[1]
  if (!part) throw new Error('Malformed id_token')
  const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = Uint8Array.from(json, (c) => c.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
}

export function identityFromClaims(claims: Record<string, unknown>): {
  email: string | null
  name: string
} {
  const pick = (k: string) => (typeof claims[k] === 'string' ? (claims[k] as string) : '')
  const email = pick('email') || pick('preferred_username') || pick('upn')
  return { email: email.includes('@') ? email : null, name: pick('name') }
}
