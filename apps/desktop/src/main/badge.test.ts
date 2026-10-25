import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { BadgeController, badgeLabel, badgePng } from './badge'

describe('badge image', () => {
  it('is a valid 32x32 RGBA PNG', () => {
    const png = badgePng(7)
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(png.readUInt32BE(16)).toBe(32)
    expect(png.readUInt32BE(20)).toBe(32)
    const idat = png.indexOf('IDAT')
    const len = png.readUInt32BE(idat - 4)
    expect(inflateSync(png.subarray(idat + 4, idat + 4 + len)).length).toBe((32 * 4 + 1) * 32)
    expect(png.subarray(-8, -4).toString('ascii')).toBe('IEND'.slice(0, 4))
  })

  it('draws different counts differently, with white digits on a filled circle', () => {
    expect(badgePng(1).equals(badgePng(2))).toBe(false)
    const raw = inflateSync(badgePng(8).subarray(41, -12))
    const pixel = (x: number, y: number) => raw.subarray(y * 129 + 1 + x * 4, y * 129 + 1 + x * 4 + 4)
    expect([...pixel(0, 0)][3]).toBe(0) // corner is transparent
    expect([...pixel(16, 16)]).toEqual([255, 255, 255, 255]) // middle of the 8 is the white bar
  })

  it('caps the label at two digits', () => {
    expect(badgeLabel(5)).toBe('5')
    expect(badgeLabel(250)).toBe('99')
    expect(badgeLabel(-3)).toBe('0')
  })
})

describe('badge controller', () => {
  it('applies only changes, and shows nothing while hidden', () => {
    let count = 3
    let hidden = false
    const applied: number[] = []
    const b = new BadgeController({ count: () => count, hidden: () => hidden, apply: (n) => applied.push(n) })
    b.refresh()
    b.refresh()
    count = 5
    b.refresh()
    hidden = true
    b.refresh()
    hidden = false
    b.refresh()
    expect(applied).toEqual([3, 5, 0, 5])
  })
})

describe('inbox unread count', () => {
  it('counts unread inbox mail only, leaving out other folders and snoozed mail', async () => {
    const { default: Database } = await import('better-sqlite3')
    const { migrate } = await import('./db')
    const { MailStore } = await import('./store')
    const db = new Database(':memory:')
    migrate(db)
    const store = new MailStore(db)
    const acct = store.addAccount(
      { email: 'me@x.example', username: 'me', imap: { host: 'h', port: 993, security: 'tls' }, smtp: { host: 'h', port: 465, security: 'tls' } },
      'imap'
    ).id
    const inbox = store.upsertFolder(acct, { path: 'INBOX', name: 'Inbox', role: 'inbox' })
    const trash = store.upsertFolder(acct, { path: 'Trash', name: 'Trash', role: 'trash' })
    const m = (uid: number, flags: string[]) => ({ uid, messageId: `<${uid}@x>`, fromName: 'A', fromAddr: 'a@b.example', to: 'me@x.example', subject: `s${uid}`, date: uid, flags, refs: [] })
    store.applyFetched(acct, inbox, [m(1, []), m(2, []), m(3, ['\\Seen'])], null)
    store.applyFetched(acct, trash, [m(1, [])], null)
    expect(store.inboxUnread()).toBe(2)
    store.snooze(`${inbox}:2`, Date.now() + 1e6)
    expect(store.inboxUnread()).toBe(1)
  })
})
