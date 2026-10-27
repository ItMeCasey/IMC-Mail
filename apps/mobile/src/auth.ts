import * as AuthSession from 'expo-auth-session'
import * as WebBrowser from 'expo-web-browser'
import * as SecureStore from 'expo-secure-store'
import { decodeJwtPayload, identityFromClaims, oauthProviders, type OAuthProviderId } from '@imc/core'
import { isFresh, refreshTokens, storageKey, type Tokens } from '@imc/mail'
import { GOOGLE_ANDROID_CLIENT_ID, GOOGLE_REDIRECT, MICROSOFT_CLIENT_ID, MICROSOFT_REDIRECT } from './config'

// Lets the sign-in browser tab hand control back to the app.
WebBrowser.maybeCompleteAuthSession()

export interface PhoneAccount {
  provider: OAuthProviderId
  email: string
  name: string
}

const ACCOUNTS_KEY = 'imc.accounts'
/** The keystore only allows letters, digits, ".", "-" and "_" in a key, so the address is encoded. */
const tokenKey = (email: string) => storageKey('imc.refresh', email)
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

  const token = await AuthSession.exchangeCodeAsync(
    { clientId, code, redirectUri, extraParams: { code_verifier: request.codeVerifier } },
    { tokenEndpoint: def.tokenUrl }
  )
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

/** An access token for this account, refreshed when it has run out. */
export async function accessToken(account: PhoneAccount): Promise<string> {
  const cached = memory.get(account.email)
  if (cached && isFresh(cached, Date.now())) return cached.accessToken
  const refresh = await SecureStore.getItemAsync(tokenKey(account.email))
  if (!refresh) throw new Error('This account needs to be signed in again')
  const def = oauthProviders[account.provider]
  const fresh = await refreshTokens({ tokenUrl: def.tokenUrl, clientId: clientFor(account.provider).clientId, ...(scopeFor(account.provider) ? { scope: scopeFor(account.provider)! } : {}) }, refresh)
  if (fresh.refreshToken !== refresh) await SecureStore.setItemAsync(tokenKey(account.email), fresh.refreshToken)
  memory.set(account.email, fresh)
  return fresh.accessToken
}

export async function removeAccount(email: string): Promise<void> {
  memory.delete(email)
  await SecureStore.deleteItemAsync(tokenKey(email))
  await saveAccounts((await loadAccounts()).filter((a) => a.email !== email))
}
