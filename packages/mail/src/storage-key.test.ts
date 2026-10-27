import { describe, expect, it } from 'vitest'
import { storageKey } from './storage-key'

describe('storageKey', () => {
  it('only uses characters the phone allows', () => {
    for (const text of ['me@example.com', 'First.Last+tag@Sub.Example.co.uk', "o'brien@x.example", 'a_b@x.example', '名前@x.example']) {
      expect(storageKey('imc.refresh', text)).toMatch(/^[A-Za-z0-9._-]+$/)
    }
  })

  it('writes the same text the same way, ignoring case', () => {
    expect(storageKey('p', 'Me@Example.com')).toBe(storageKey('p', 'me@example.com'))
    expect(storageKey('p', 'me@example.com')).toBe('p.me_40_example.com')
  })

  it('never gives two different addresses the same key', () => {
    const keys = ['a_40_b@x', 'a@b@x', 'a@b_40_x', 'a_b@x', 'a-b@x', 'a.b@x'].map((t) => storageKey('p', t))
    expect(new Set(keys).size).toBe(keys.length)
  })
})
