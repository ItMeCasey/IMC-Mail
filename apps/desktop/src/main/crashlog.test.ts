import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CrashLog } from './crashlog'

const fresh = () => join(mkdtempSync(join(tmpdir(), 'imc-crash-')), 'crash-log.json')

describe('CrashLog', () => {
  it('records errors with the time, scrubbed of addresses and your user name', () => {
    const f = fresh()
    const log = new CrashLog(f, () => 1000)
    log.add('error', Object.assign(new Error('could not send to pat@nova.example'), { stack: 'Error: x\n    at C:\\Users\\casey\\app\\a.js:3:4' }))
    const [e] = log.list()
    expect(e).toMatchObject({ at: 1000, kind: 'error', message: 'could not send to <email>' })
    expect(e!.stack).toContain('C:\\Users\\<user>\\app\\a.js')
    expect(readFileSync(f, 'utf8')).not.toContain('casey')
  })
  it('accepts things that are not Error objects', () => {
    const log = new CrashLog(fresh())
    log.add('rejection', 'plain text')
    log.add('renderer-gone', { reason: 'crashed' })
    expect(log.list().map((x) => x.message)).toEqual(['plain text', '{"reason":"crashed"}'])
  })
  it('keeps only the newest twenty', () => {
    let t = 0
    const log = new CrashLog(fresh(), () => ++t)
    for (let i = 0; i < 30; i++) log.add('error', new Error(`e${i}`))
    const all = log.list()
    expect(all).toHaveLength(20)
    expect(all[0]!.message).toBe('e10')
  })
  it('treats a damaged file as an empty log, and never throws when it cannot write', () => {
    const f = fresh()
    writeFileSync(f, '{not json')
    expect(new CrashLog(f).list()).toEqual([])
    expect(() => new CrashLog(join(f, 'nope', 'x.json')).add('error', new Error('x'))).not.toThrow()
  })
})
