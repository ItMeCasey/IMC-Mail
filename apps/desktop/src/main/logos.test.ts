import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLogos, logoUrl } from './logos'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
let dir: string
let calls: string[]
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'imc-logos-'))
  calls = []
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const fetchFor = (known: Record<string, { type?: string; bytes?: Buffer; status?: number }>) =>
  (async (url: string | URL | Request) => {
    const u = String(url)
    calls.push(u)
    const domain = /url=https:\/\/([^&]+)/.exec(u)![1]!
    const r = known[domain]
    if (!r) return new Response('', { status: 404 })
    return new Response(new Uint8Array(r.bytes ?? PNG), { status: r.status ?? 200, headers: { 'content-type': r.type ?? 'image/png' } })
  }) as typeof fetch

describe('company logos', () => {
  it('returns an inline picture for a domain that has one, and null for one that has not', async () => {
    const logos = createLogos({ dir, fetchFn: fetchFor({ 'spotify.com': {} }) })
    const out = await logos.get(['spotify.com', 'nothing-here.example'])
    expect(out['spotify.com']).toBe(`data:image/png;base64,${PNG.toString('base64')}`)
    expect(out['nothing-here.example']).toBeNull()
  })

  it('asks the service once, then answers from memory and from disk', async () => {
    const f = fetchFor({ 'spotify.com': {} })
    await createLogos({ dir, fetchFn: f }).get(['spotify.com'])
    const again = createLogos({ dir, fetchFn: f })
    expect((await again.get(['spotify.com']))['spotify.com']).not.toBeNull()
    await again.get(['spotify.com'])
    expect(calls).toHaveLength(1)
  })

  it('remembers a miss for a few days, then looks again', async () => {
    let t = Date.now()
    const logos = createLogos({ dir, fetchFn: fetchFor({}), now: () => t })
    await logos.get(['nope.example'])
    await logos.get(['nope.example'])
    expect(calls).toHaveLength(1)
    t += 4 * 86_400_000
    await createLogos({ dir, fetchFn: fetchFor({}), now: () => t }).get(['nope.example'])
    expect(calls).toHaveLength(2)
  })

  it('joins repeated asks for the same domain into one request', async () => {
    const logos = createLogos({ dir, fetchFn: fetchFor({ 'a.example': {} }) })
    await Promise.all([logos.get(['a.example']), logos.get(['A.example', 'a.example'])])
    expect(calls).toHaveLength(1)
  })

  it('refuses things that are not a picture, are too big, or are not a plain domain name', async () => {
    const logos = createLogos({
      dir,
      fetchFn: fetchFor({ 'html.example': { type: 'text/html' }, 'big.example': { bytes: Buffer.alloc(90_000) }, 'svg.example': { type: 'image/svg+xml' }, 'bad.example': { status: 500 } })
    })
    const out = await logos.get(['html.example', 'big.example', 'svg.example', 'bad.example', 'localhost', '../etc', 'a b.com', 'x.com/../../y'])
    expect(out).toEqual({ 'html.example': null, 'big.example': null, 'svg.example': null, 'bad.example': null })
    expect(calls.every((u) => u.startsWith('https://t3.gstatic.com/'))).toBe(true)
  })

  it('builds the service address from the domain', () => {
    expect(logoUrl('uber.com')).toContain('url=https://uber.com&size=64')
  })
})
