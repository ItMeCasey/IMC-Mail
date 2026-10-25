import { describe, expect, it } from 'vitest'
import type { FetchMessageObject } from 'imapflow'
import { describeError, folderName, roleFor, toFetched } from './engine'

describe('roleFor', () => {
  it('detects the inbox case-insensitively and maps special-use flags', () => {
    expect(roleFor('inbox')).toBe('inbox')
    expect(roleFor('[Gmail]/Sent Mail', '\\Sent')).toBe('sent')
    expect(roleFor('[Gmail]/All Mail', '\\All')).toBe('all')
    expect(roleFor('Receipts')).toBeNull()
  })
})

describe('folderName', () => {
  it('uses the last path segment', () => {
    expect(folderName('INBOX', '/')).toBe('Inbox')
    expect(folderName('[Gmail]/Sent Mail', '/')).toBe('Sent Mail')
    expect(folderName('INBOX.Work.Brands', '.')).toBe('Brands')
  })
})

describe('toFetched', () => {
  it('maps an envelope', () => {
    const m = {
      seq: 1,
      uid: 42,
      flags: new Set(['\\Seen']),
      internalDate: new Date('2026-01-02T03:04:05Z'),
      envelope: {
        subject: 'Collab?',
        messageId: '<a@b>',
        date: new Date('2026-01-02T03:00:00Z'),
        from: [{ name: 'Brand Co', address: 'deals@brand.co' }],
        to: [{ address: 'me@x.com' }, { address: 'you@x.com' }]
      }
    } as unknown as FetchMessageObject
    expect(toFetched(m)).toEqual({
      uid: 42,
      messageId: '<a@b>',
      fromName: 'Brand Co',
      fromAddr: 'deals@brand.co',
      to: 'me@x.com, you@x.com',
      subject: 'Collab?',
      date: Date.parse('2026-01-02T03:00:00Z'),
      flags: ['\\Seen'],
      refs: []
    })
  })

  it('tolerates a sparse message and falls back to internalDate', () => {
    const m = {
      seq: 1,
      uid: 7,
      internalDate: '2026-01-02T03:04:05Z'
    } as unknown as FetchMessageObject
    expect(toFetched(m)).toMatchObject({
      uid: 7,
      subject: '',
      fromAddr: '',
      flags: [],
      date: Date.parse('2026-01-02T03:04:05Z')
    })
  })
})

describe('describeError', () => {
  it('gives friendly messages for auth and network failures', () => {
    const server = { host: 'imap.x.com', port: 993, security: 'tls' as const }
    expect(describeError({ authenticationFailed: true, responseText: 'bad pw' })).toBe(
      'Sign-in rejected: bad pw'
    )
    expect(describeError({ code: 'ENOTFOUND' }, server)).toBe('Cannot reach imap.x.com:993')
  })
})
