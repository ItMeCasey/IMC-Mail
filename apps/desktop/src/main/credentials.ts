import type { SecretStore } from './secrets'
import type { TokenProvider } from './oauth'
import type { AccountRow } from './store'

export type Credential = { pass: string } | { accessToken: string }

/** Resolves the right login credential for an account: stored password or a fresh OAuth token. */
export class Credentials {
  constructor(
    private secrets: SecretStore,
    private tokens: TokenProvider
  ) {}

  async get(account: AccountRow): Promise<Credential> {
    if (account.config.auth === 'oauth') {
      return { accessToken: await this.tokens.getAccessToken(account.id) }
    }
    const pass = await this.secrets.get(`account:${account.id}`)
    if (pass === undefined) throw new Error('Saved password not found, re-add the account')
    return { pass }
  }

  async setPassword(accountId: string, password: string): Promise<void> {
    await this.secrets.set(`account:${accountId}`, password)
  }

  async remove(accountId: string): Promise<void> {
    await this.secrets.delete(`account:${accountId}`)
    await this.tokens.delete(accountId)
  }
}
