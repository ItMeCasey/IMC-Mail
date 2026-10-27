import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DraftAttachment } from '@imc/core'
import { LaunchInbox } from './launch'

const file = (path: string): DraftAttachment => ({ id: path, filename: path.split('\\').pop()!, size: 10, path })

let ready: number
let failures: string[]
let vetted: string[][]

const inbox = (vet?: (p: string[]) => Promise<DraftAttachment[]>) =>
  new LaunchInbox({
    vet: vet ?? (async (p) => (vetted.push(p), p.map(file))),
    ready: () => void ready++,
    fail: (m) => void failures.push(m)
  })

/** Lets the gathering delay pass and the file checks finish. */
const settle = async () => {
  await vi.advanceTimersByTimeAsync(1300)
}

beforeEach(() => {
  vi.useFakeTimers()
  ready = 0
  failures = []
  vetted = []
})
afterEach(() => vi.useRealTimers())

describe('messages started from outside the app', () => {
  it('opens a message for a mailto link', async () => {
    const i = inbox()
    i.handle(['IMC-Mail.exe', 'mailto:pat@brand.example?subject=Hi&body=Hello'])
    expect(ready).toBe(0)
    await settle()
    expect(ready).toBe(1)
    expect(i.take()).toEqual({ to: ['pat@brand.example'], cc: [], bcc: [], subject: 'Hi', body: 'Hello', attachments: [] })
    expect(i.take()).toBeNull()
  })

  it('attaches a file sent with "Mail this"', async () => {
    const i = inbox()
    i.handle(['IMC-Mail.exe', '--attach', 'C:\\Users\\me\\report.pdf'])
    await settle()
    expect(i.take()).toMatchObject({ to: [], subject: '', attachments: [{ filename: 'report.pdf', path: 'C:\\Users\\me\\report.pdf' }] })
  })

  it('gathers files chosen together, which arrive as separate launches, into one message', async () => {
    const i = inbox()
    i.handle(['x.exe', '--attach', 'C:\\a.txt'])
    await vi.advanceTimersByTimeAsync(300)
    i.handle(['x.exe', '--attach', 'C:\\b.txt'])
    await vi.advanceTimersByTimeAsync(300)
    i.handle(['x.exe', '--attach', 'C:\\c.txt'])
    await settle()
    expect(ready).toBe(1)
    expect(i.take()?.attachments.map((a) => a.filename)).toEqual(['a.txt', 'b.txt', 'c.txt'])
  })

  it('does not attach the same file twice', async () => {
    const i = inbox()
    i.handle(['x.exe', '--attach', 'C:\\a.txt', '--attach', 'C:\\a.txt'])
    await settle()
    expect(i.take()?.attachments).toHaveLength(1)
  })

  it('combines a link and a file, and joins what arrives before the window has asked', async () => {
    const i = inbox()
    i.handle(['x.exe', 'mailto:a@x.example?subject=One'])
    await settle()
    i.handle(['x.exe', '--attach', 'C:\\f.txt'])
    await settle()
    expect(ready).toBe(2)
    expect(i.take()).toMatchObject({ subject: '', attachments: [{ filename: 'f.txt' }] })
  })

  it('ignores a launch that has nothing to open, or a link that is not usable', async () => {
    const i = inbox()
    i.handle(['x.exe'])
    i.handle(['x.exe', '--hidden'])
    i.handle(['x.exe', 'mailto:'])
    await settle()
    expect(ready).toBe(0)
    expect(i.take()).toBeNull()
  })

  it('keeps going when one file cannot be attached, and says which', async () => {
    const i = inbox(async (p) => {
      if (p[0]!.includes('huge')) throw new Error('huge.iso is larger than 25 MB')
      return p.map(file)
    })
    i.handle(['x.exe', '--attach', 'C:\\ok.txt', '--attach', 'C:\\huge.iso'])
    await settle()
    expect(failures).toEqual(['huge.iso is larger than 25 MB'])
    expect(i.take()?.attachments.map((a) => a.filename)).toEqual(['ok.txt'])
  })

  it('says so, and opens nothing, when the only file cannot be attached', async () => {
    const i = inbox(async () => {
      throw new Error('folder is not a file')
    })
    i.handle(['x.exe', '--attach', 'C:\\folder'])
    await settle()
    expect(failures).toEqual(['folder is not a file'])
    expect(ready).toBe(0)
    expect(i.take()).toBeNull()
  })
})
