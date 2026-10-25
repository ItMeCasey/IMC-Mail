import type { MailStore } from '../store'
import type { Credentials } from '../credentials'
import { AccountSync } from './engine'

export class SyncManager {
  private running = new Map<string, AccountSync>()

  constructor(
    private store: MailStore,
    private credentials: Credentials,
    private onChange: (accountId: string) => void
  ) {}

  startAll(): void {
    for (const a of this.store.listAccounts()) this.start(a.id)
  }

  start(accountId: string): void {
    if (this.running.has(accountId)) return
    const account = this.store.getAccount(accountId)
    if (!account) return
    const sync = new AccountSync(account, this.store, this.credentials, this.onChange)
    this.running.set(accountId, sync)
    sync.start()
  }

  private get(accountId: string): AccountSync {
    const s = this.running.get(accountId)
    if (!s) throw new Error('This account is not syncing')
    return s
  }

  fetchSource(accountId: string, path: string, uid: number, maxBytes: number) {
    return this.get(accountId).fetchSource(path, uid, maxBytes)
  }

  setFlags(
    accountId: string,
    path: string,
    uid: number,
    change: { add?: string[]; remove?: string[] }
  ) {
    return this.get(accountId).setFlags(path, uid, change)
  }

  resync(accountId: string): void {
    this.running.get(accountId)?.resync()
  }

  stop(accountId: string): void {
    this.running.get(accountId)?.stop()
    this.running.delete(accountId)
  }

  stopAll(): void {
    for (const id of [...this.running.keys()]) this.stop(id)
  }
}
