import { describe, expect, it } from 'vitest'
import { ipcContract } from './ipc'

describe('ipcContract', () => {
  it('accepts a valid ping and rejects an oversized one', () => {
    const { input } = ipcContract['app:ping']
    expect(input.safeParse({ message: 'hi' }).success).toBe(true)
    expect(input.safeParse({ message: 'x'.repeat(201) }).success).toBe(false)
  })
})
