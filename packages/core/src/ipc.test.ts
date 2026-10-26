import { describe, expect, it } from 'vitest'
import { ipcContract } from './ipc'

describe('ipcContract', () => {
  it('accepts a valid ping and rejects an oversized one', () => {
    const { input } = ipcContract['app:ping']
    expect(input.safeParse({ message: 'hi' }).success).toBe(true)
    expect(input.safeParse({ message: 'x'.repeat(201) }).success).toBe(false)
  })

  it('refuses unencrypted mail servers unless they are on this computer', () => {
    const { input } = ipcContract['accounts:add']
    const acct = (host: string, security: string) => ({
      email: 'a@b.example',
      username: 'a',
      password: 'pw',
      imap: { host, port: 143, security },
      smtp: { host, port: 25, security: 'starttls' }
    })
    expect(input.safeParse(acct('mail.example.com', 'none')).success).toBe(false)
    expect(input.safeParse(acct('mail.example.com', 'starttls')).success).toBe(true)
    expect(input.safeParse(acct('mail.example.com', 'tls')).success).toBe(true)
    expect(input.safeParse(acct('127.0.0.1', 'none')).success).toBe(true)
    expect(input.safeParse(acct('localhost', 'none')).success).toBe(true)
  })

  it('only accepts plain web addresses as a meeting link', () => {
    const { input } = ipcContract['calendar:schedule']
    const base = { summary: 'x', start: 1, end: 2, attendees: ['a@b.example'], accountId: 'a' }
    expect(input.safeParse({ ...base, onlineUrl: 'https://meet.example.com/j/1' }).success).toBe(true)
    expect(input.safeParse({ ...base, onlineUrl: 'javascript:alert(1)' }).success).toBe(false)
    expect(input.safeParse({ ...base, onlineUrl: 'https://x.example/"a' }).success).toBe(false)
  })
})
