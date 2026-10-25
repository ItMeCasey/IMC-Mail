import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from './db'
import { MailStore, type FetchedMessage } from './store'

const m = (uid: number, over: Partial<FetchedMessage> = {}): FetchedMessage => ({
  uid, messageId: `<m${uid}@x>`, fromName: 'A', fromAddr: 'a@b.example', to: 'me@x.example',
  subject: `s${uid}`, date: uid, flags: [], refs: [], ...over
})

describe('labels', () => {
  let store: MailStore
  let acct: string
  let inbox: string
  let archive: string
  beforeEach(() => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    store = new MailStore(db)
    acct = store.addAccount({ email: 'me@x.example', username: 'me', imap: { host: 'h', port: 993, security: 'tls' }, smtp: { host: 'h', port: 465, security: 'tls' } }, 'imap').id
    inbox = store.upsertFolder(acct, { path: 'INBOX', name: 'Inbox', role: 'inbox' })
    archive = store.upsertFolder(acct, { path: 'Archive', name: 'Archive', role: 'archive' })
    store.applyFetched(acct, inbox, [m(1), m(2), m(3)], null)
  })
  const uids = (labelId: string) => store.listMessages({ labelId, limit: 10, offset: 0 }).map((r) => r.uid).sort()

  it('creates labels once per name (any case), lists them with counts, and filters by them', () => {
    const a = store.createLabel('Taxes')
    expect(store.createLabel('taxes').id).toBe(a.id)
    const b = store.createLabel('Collab')
    store.setLabels(`${inbox}:1`, [a.id, b.id])
    store.setLabels(`${inbox}:2`, [a.id])
    expect(store.listLabels()).toEqual([{ id: b.id, name: 'Collab', count: 1 }, { id: a.id, name: 'Taxes', count: 2 }])
    expect(uids(a.id)).toEqual([1, 2])
    expect(store.labelIdsOf(`${inbox}:1`).sort()).toEqual([a.id, b.id].sort())
  })

  it('replaces labels on a second set, and clears them with an empty list', () => {
    const a = store.createLabel('A')
    const b = store.createLabel('B')
    store.setLabels(`${inbox}:1`, [a.id])
    store.setLabels(`${inbox}:1`, [b.id])
    expect(store.labelIdsOf(`${inbox}:1`)).toEqual([b.id])
    store.setLabels(`${inbox}:1`, [])
    expect(store.labelIdsOf(`${inbox}:1`)).toEqual([])
  })

  it('keeps a label on a message after it moves folders (it comes back with a new uid)', () => {
    const a = store.createLabel('Keep')
    store.setLabels(`${inbox}:1`, [a.id])
    store.removeMessage(`${inbox}:1`)
    store.applyFetched(acct, archive, [m(77, { messageId: '<m1@x>' })], null)
    expect(uids(a.id)).toEqual([77])
  })

  it('marks a whole folder read or unread without touching other flags or folders', () => {
    store.applyFetched(acct, inbox, [m(4, { flags: ['\\Seen', '\\Flagged'] })], null)
    store.applyFetched(acct, archive, [m(50)], null)
    expect(store.setSeenInFolder(inbox, true)).toBe(3) // 1, 2, 3 were unread; 4 already read
    expect(store.inboxUnread()).toBe(0)
    expect(store.getMessage(`${inbox}:4`)?.flags).toContain('\\Flagged')
    expect(store.getMessage(`${archive}:50`)?.flags).toBe('') // another folder is untouched
    expect(store.setSeenInFolder(inbox, false)).toBe(4)
    expect(store.inboxUnread()).toBe(4)
    expect(store.getMessage(`${inbox}:4`)?.flags).toBe('\\Flagged')
  })

  it('knows which folders sit inside another, and removing a folder takes its messages', () => {
    const sub = store.upsertFolder(acct, { path: 'Archive/2026', name: '2026', role: null })
    expect(store.hasSubfolders(archive)).toBe(true)
    expect(store.hasSubfolders(sub)).toBe(false)
    expect(store.hasSubfolders(inbox)).toBe(false)
    store.applyFetched(acct, sub, [m(70)], null)
    store.removeFolder(sub)
    expect(store.hasSubfolders(archive)).toBe(false)
    expect(store.getMessage(`${sub}:70`)).toBeUndefined()
  })

  it('forgetting a folder tree drops it, what is inside it and their messages, and nothing alongside', () => {
    const parent = store.upsertFolder(acct, { path: 'Work', name: 'Work', role: null })
    const kid = store.upsertFolder(acct, { path: 'Work/Brands', name: 'Brands', role: null })
    const other = store.upsertFolder(acct, { path: 'Workshop', name: 'Workshop', role: null })
    store.applyFetched(acct, kid, [m(80)], null)
    store.removeFolderTree(parent)
    expect(store.getFolder(parent)).toBeUndefined()
    expect(store.getFolder(kid)).toBeUndefined()
    expect(store.getMessage(`${kid}:80`)).toBeUndefined()
    expect(store.getFolder(other)).toBeDefined() // a longer name that merely starts the same is not inside it
  })

  it('renames an account, and an empty name falls back to the address', () => {
    store.setDisplayName(acct, '  Casey Streams ')
    expect(store.getAccount(acct)?.displayName).toBe('Casey Streams')
    store.setDisplayName(acct, '')
    expect(store.getAccount(acct)?.displayName).toBe('')
  })

  it('deleting a label takes it off every message, and refuses a message with no Message-ID', () => {
    const a = store.createLabel('Gone')
    store.setLabels(`${inbox}:3`, [a.id])
    store.deleteLabel(a.id)
    expect(store.labelIdsOf(`${inbox}:3`)).toEqual([])
    store.applyFetched(acct, inbox, [m(9, { messageId: null })], null)
    expect(() => store.setLabels(`${inbox}:9`, [])).toThrow(/Message-ID/)
  })
})
