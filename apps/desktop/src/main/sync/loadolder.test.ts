import { describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from '../db'
import { MailStore } from '../store'
import { AccountSync } from './engine'

describe('load older mail', () => {
  const setup = () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    const store = new MailStore(db)
    const acct = store.addAccount({ email: 'me@x.example', username: 'me', imap: { host: 'h', port: 993, security: 'tls' }, smtp: { host: 'h', port: 465, security: 'tls' } }, 'imap')
    const inbox = store.upsertFolder(acct.id, { path: 'INBOX', name: 'Inbox', role: 'inbox' })
    const row = (uid: number) => ({ uid, messageId: `<m${uid}@x>`, fromName: 'A', fromAddr: 'a@b.example', to: 'me@x.example', subject: `s${uid}`, date: uid, flags: [], refs: [] })
    store.applyFetched(acct.id, inbox, [row(500), row(501)], null)
    const changed = vi.fn()
    const sync = new AccountSync(store.getAccount(acct.id)!, store, {} as never, changed)
    const server = Array.from({ length: 450 }, (_, i) => i + 1) // uids 1..450 older than 500
    const fetchedRanges: string[] = []
    ;(sync as unknown as { client: unknown }).client = {
      usable: true,
      getMailboxLock: async () => ({ release: vi.fn() }),
      search: async (q: { uid: string }) => {
        const hi = Number(q.uid.split(':')[1])
        return server.filter((u) => u <= hi)
      },
      fetch: async function* (range: string) {
        fetchedRanges.push(range)
        const [lo, hi] = range.split(':').map(Number)
        for (let u = lo!; u <= hi!; u++) {
          yield { uid: u, envelope: { messageId: `<m${u}@x>`, subject: `s${u}`, from: [{ address: 'a@b.example' }], to: [{ address: 'me@x.example' }], date: new Date(u * 1000) }, flags: new Set<string>(), internalDate: new Date(u * 1000) }
        }
      }
    }
    return { store, inbox, sync, changed, fetchedRanges }
  }

  it('adds the next 200 older messages, then the rest, and never removes anything', async () => {
    const { store, inbox, sync, changed, fetchedRanges } = setup()
    const folder = { id: inbox, path: 'INBOX' }
    expect(await sync.loadOlder(folder)).toEqual({ loaded: 200, more: true })
    expect(fetchedRanges).toEqual(['251:450'])
    expect(store.oldestUid(inbox)).toBe(251)
    expect(await sync.loadOlder(folder)).toEqual({ loaded: 200, more: true })
    expect(await sync.loadOlder(folder)).toEqual({ loaded: 50, more: false })
    expect(store.oldestUid(inbox)).toBe(1)
    expect(await sync.loadOlder(folder)).toEqual({ loaded: 0, more: false })
    expect(store.listMessages({ folderId: inbox, limit: 500, offset: 0 }).length).toBe(452)
    expect(changed).toHaveBeenCalled()
  })

  it('says so when offline', async () => {
    const { sync, inbox } = setup()
    ;(sync as unknown as { client: unknown }).client = { usable: false }
    await expect(sync.loadOlder({ id: inbox, path: 'INBOX' })).rejects.toThrow(/Offline/)
  })
})
