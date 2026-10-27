import * as AuthSession from 'expo-auth-session'
import * as WebBrowser from 'expo-web-browser'
import * as SecureStore from 'expo-secure-store'
import { decodeJwtPayload, identityFromClaims, oauthProviders, type OAuthProviderId, type ServerConfig } from '@imc/core'
import { isFresh, refreshTokens, storageKey, type Tokens } from '@imc/mail'
import { GOOGLE_ANDROID_CLIENT_ID, GOOGLE_REDIRECT, MICROSOFT_CLIENT_ID, MICROSOFT_REDIRECT } from './config'

// Lets the sign-in browser tab hand control back to the app.
WebBrowser.maybeCompleteAuthSession()

/** An account on this phone. Google and Microsoft sign in through the provider; anything else ('imap') uses a password. */
export interface PhoneAccount {
  provider: OAuthProviderId | 'imap'
  email: string
  name: string
  /** How mail is read. IMAP unless the account says POP3. */
  protocol?: 'imap' | 'pop3'
  /** The user name for a password account, if it is not the address. */
  username?: string
  /** Servers for a password account; Google and Microsoft accounts use the known ones. */
  incoming?: ServerConfig
  outgoing?: ServerConfig
}

const ACCOUNTS_KEY = 'imc.accounts'
/** The keystore only allows letters, digits, ".", "-" and "_" in a key, so the address is encoded. */
const tokenKey = (email: string) => storageKey('imc.refresh', email)
const passwordKey = (email: string) => storageKey('imc.password', email)
/** Access tokens are short-lived and kept in memory only; the refresh token is in the system keystore. */
const memory = new Map<string, Tokens>()

const clientFor = (p: OAuthProviderId) => (p === 'gmail' ? { clientId: GOOGLE_ANDROID_CLIENT_ID, redirectUri: GOOGLE_REDIRECT } : { clientId: MICROSOFT_CLIENT_ID, redirectUri: MICROSOFT_REDIRECT })

/** Microsoft hands out tokens for one resource at a time, so refreshing must name the mail one again. */
const scopeFor = (p: OAuthProviderId) => (p === 'microsoft' ? oauthProviders.microsoft.scopes.join(' ') : undefined)

export async function loadAccounts(): Promise<PhoneAccount[]> {
  try {
    const raw = await SecureStore.getItemAsync(ACCOUNTS_KEY)
    return raw ? (JSON.parse(raw) as PhoneAccount[]) : []
  } catch {
    return []
  }
}

async function saveAccounts(list: PhoneAccount[]): Promise<void> {
  await SecureStore.setItemAsync(ACCOUNTS_KEY, JSON.stringify(list))
}

/** The servers an account talks to: the known ones for Google and Microsoft, the ones the person entered otherwise. */
export function serversOf(account: PhoneAccount): { incoming: ServerConfig; outgoing: ServerConfig } {
  if (account.provider !== 'imap') return { incoming: oauthProviders[account.provider].imap, outgoing: oauthProviders[account.provider].smtp }
  if (!account.incoming || !account.outgoing) throw new Error('This account has no mail server set')
  return { incoming: account.incoming, outgoing: account.outgoing }
}

/** Opens the provider's sign-in page in the browser, then stores the account and returns it. */
export async function signIn(provider: OAuthProviderId): Promise<PhoneAccount> {
  const def = oauthProviders[provider]
  const { clientId, redirectUri } = clientFor(provider)
  const request = new AuthSession.AuthRequest({
    clientId,
    redirectUri,
    scopes: def.scopes,
    responseType: AuthSession.ResponseType.Code,
    usePKCE: true,
    extraParams: def.authParams
  })
  const result = await request.promptAsync({ authorizationEndpoint: def.authorizeUrl })
  if (result.type === 'cancel' || result.type === 'dismiss') throw new Error('Sign-in was cancelled')
  if (result.type !== 'success') throw new Error(result.type === 'error' ? (result.error?.message ?? 'Sign-in failed') : 'Sign-in failed')
  const code = result.params['code']
  if (!code || !request.codeVerifier) throw new Error('The sign-in page did not return a code')

  const token = await AuthSession.exchangeCodeAsync({ clientId, code, redirectUri, extraParams: { code_verifier: request.codeVerifier } }, { tokenEndpoint: def.tokenUrl })
  if (!token.refreshToken) throw new Error('The provider did not return a refresh token. Remove IMC-Mail from your account permissions and try again.')
  const who = token.idToken ? identityFromClaims(decodeJwtPayload(token.idToken)) : { email: null, name: '' }
  if (!who.email) throw new Error('Could not read your email address from the sign-in')

  const account: PhoneAccount = { provider, email: who.email.toLowerCase(), name: who.name }
  await SecureStore.setItemAsync(tokenKey(account.email), token.refreshToken)
  memory.set(account.email, { accessToken: token.accessToken, refreshToken: token.refreshToken, expiresAt: Date.now() + (token.expiresIn ?? 3600) * 1000 })
  const others = (await loadAccounts()).filter((a) => a.email !== account.email)
  await saveAccounts([...others, account])
  return account
}

/** Saves an account that signs in with a password (any IMAP or POP3 provider). The password goes in the system keystore. */
export async function addPasswordAccount(a: { email: string; name: string; username: string; password: string; protocol: 'imap' | 'pop3'; incoming: ServerConfig; outgoing: ServerConfig }): Promise<PhoneAccount> {
  const account: PhoneAccount = { provider: 'imap', email: a.email.trim().toLowerCase(), name: a.name.trim(), protocol: a.protocol, username: a.username.trim(), incoming: a.incoming, outgoing: a.outgoing }
  await SecureStore.setItemAsync(passwordKey(account.email), a.password)
  const others = (await loadAccounts()).filter((x) => x.email !== account.email)
  await saveAccounts([...others, account])
  return account
}

/** What is needed to sign in to this account's servers. */
export async function credentials(account: PhoneAccount): Promise<{ kind: 'oauth'; user: string; token: string } | { kind: 'password'; user: string; password: string }> {
  if (account.provider === 'imap') {
    const password = await SecureStore.getItemAsync(passwordKey(account.email))
    if (!password) throw new Error('The password for this account is missing. Remove the account and add it again.')
    return { kind: 'password', user: account.username || account.email, password }
  }
  return { kind: 'oauth', user: account.email, token: await accessToken(account) }
}

/** An access token for a Google or Microsoft account, refreshed when it has run out. */
export async function accessToken(account: PhoneAccount): Promise<string> {
  if (account.provider === 'imap') throw new Error('This account signs in with a password')
  const cached = memory.get(account.email)
  if (cached && isFresh(cached, Date.now())) return cached.accessToken
  const refresh = await SecureStore.getItemAsync(tokenKey(account.email))
  if (!refresh) throw new Error('This account needs to be signed in again')
  const def = oauthProviders[account.provider]
  const scope = scopeFor(account.provider)
  const fresh = await refreshTokens({ tokenUrl: def.tokenUrl, clientId: clientFor(account.provider).clientId, ...(scope ? { scope } : {}) }, refresh)
  if (fresh.refreshToken !== refresh) await SecureStore.setItemAsync(tokenKey(account.email), fresh.refreshToken)
  memory.set(account.email, fresh)
  return fresh.accessToken
}

export async function removeAccount(email: string): Promise<void> {
  memory.delete(email)
  await SecureStore.deleteItemAsync(tokenKey(email))
  await SecureStore.deleteItemAsync(passwordKey(email))
  await saveAccounts((await loadAccounts()).filter((a) => a.email !== email))
}
