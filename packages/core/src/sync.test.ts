import { describe, expect, it } from 'vitest'
import { compareHlc, formatHlc, isPlausibleHlc, MAX_CLOCK_DRIFT_MS, parseHlc, receiveHlc, tickHlc } from './sync-clock'
import {
  fromB64,
  hashBody,
  joinHash,
  joinToken,
  newDataKey,
  newDeviceId,
  newDeviceKeys,
  newGroupId,
  opaqueId,
  openPayload,
  sealPayload,
  signText,
  toB64,
  verifyText
} from './sync-crypto'
import { mergeIncoming, newer, recordKey, syncRecordSchema, type SyncRecord } from './sync-merge'
import { canonicalRequest, decodePairing, encodePairing, formatAuth, parseAuth, syncRequest } from './sync-protocol'

const T0 = Date.UTC(2026, 9, 26, 12, 0, 0)

describe('clock', () => {
  it('formats stamps that sort as text', () => {
    const a = formatHlc({ wall: T0, counter: 0, device: 'aaaa' })
    const b = formatHlc({ wall: T0, counter: 1, device: 'aaaa' })
    const c = formatHlc({ wall: T0 + 1, counter: 0, device: 'aaaa' })
    expect([c, a, b].sort()).toEqual([a, b, c])
    expect(parseHlc(b)).toEqual({ wall: T0, counter: 1, device: 'aaaa' })
    expect(parseHlc('nonsense')).toBeNull()
  })

  it('never goes backwards, even when the wall clock does', () => {
    const first = tickHlc(null, T0, 'devA')
    const same = tickHlc(first, T0, 'devA')
    const behind = tickHlc(same, T0 - 5000, 'devA')
    expect(compareHlc(same, first)).toBe(1)
    expect(compareHlc(behind, same)).toBe(1)
  })

  it('moves ahead of a record that came from a device with a faster clock', () => {
    const fast = tickHlc(null, T0 + 60_000, 'devB')
    const seen = receiveHlc(tickHlc(null, T0, 'devA'), fast, T0, 'devA')
    expect(compareHlc(seen, fast)).toBe(1)
    // Then an edit here sorts after what was just received.
    expect(compareHlc(tickHlc(seen, T0 + 1, 'devA'), fast)).toBe(1)
  })

  it('refuses a clock that is days ahead', () => {
    const far = formatHlc({ wall: T0 + MAX_CLOCK_DRIFT_MS + 1000, counter: 0, device: 'devB' })
    expect(isPlausibleHlc(far, T0)).toBe(false)
    expect(() => receiveHlc(null, far, T0, 'devA')).toThrow(/too far ahead/)
    expect(isPlausibleHlc(formatHlc({ wall: T0 + 1000, counter: 0, device: 'devB' }), T0)).toBe(true)
  })
})

describe('crypto', () => {
  const env = { id: 'label-1', type: 'label', hlc: formatHlc({ wall: T0, counter: 0, device: 'devA' }), deleted: false }

  it('encodes and decodes base64url', () => {
    for (const n of [0, 1, 2, 3, 4, 31, 32]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255)
      expect([...fromB64(toB64(bytes))]).toEqual([...bytes])
    }
    expect(() => fromB64('a+b')).toThrow()
  })

  it('seals and opens a record', async () => {
    const key = newDataKey()
    const sealed = await sealPayload(key, env, { name: 'Sponsors', color: 'amber' })
    expect(sealed).not.toContain('Sponsors')
    expect(await openPayload(key, env, sealed)).toEqual({ name: 'Sponsors', color: 'amber' })
  })

  it('does not seal the same thing the same way twice', async () => {
    const key = newDataKey()
    expect(await sealPayload(key, env, 'x')).not.toBe(await sealPayload(key, env, 'x'))
  })

  it('refuses a wrong key, a changed payload, or a changed envelope', async () => {
    const key = newDataKey()
    const sealed = await sealPayload(key, env, { n: 1 })
    await expect(openPayload(newDataKey(), env, sealed)).rejects.toThrow()
    const flipped = sealed.slice(0, 30) + (sealed[30] === 'A' ? 'B' : 'A') + sealed.slice(31)
    await expect(openPayload(key, env, flipped)).rejects.toThrow()
    // The server cannot present this payload as another record, another kind, a newer version, or a live record.
    await expect(openPayload(key, { ...env, id: 'label-2' }, sealed)).rejects.toThrow()
    await expect(openPayload(key, { ...env, type: 'rule' }, sealed)).rejects.toThrow()
    await expect(openPayload(key, { ...env, hlc: formatHlc({ wall: T0 + 1, counter: 0, device: 'devA' }) }, sealed)).rejects.toThrow()
    await expect(openPayload(key, { ...env, deleted: true }, sealed)).rejects.toThrow()
    await expect(openPayload(key, env, 'AAAA')).rejects.toThrow()
  })

  it('derives a join proof that does not reveal the key', async () => {
    const key = newDataKey()
    const token = await joinToken(key)
    expect(token).toBe(await joinToken(key))
    expect(token).not.toBe(key)
    expect(token).not.toBe(await joinToken(newDataKey()))
    const hash = await joinHash(token)
    expect(hash).not.toBe(token)
    expect(hash).toBe(await joinHash(token))
  })

  it('signs a request and rejects a changed one', async () => {
    const { publicKey, privateKey } = await newDeviceKeys()
    expect(publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/)
    const text = canonicalRequest({ method: 'post', path: '/v1/sync', timestamp: T0, bodyHash: await hashBody('{"since":0}') })
    const sig = await signText(privateKey, text)
    expect(sig).toMatch(/^[A-Za-z0-9_-]{86}$/)
    expect(await verifyText(publicKey, text, sig)).toBe(true)
    expect(await verifyText(publicKey, text.replace('POST', 'GET'), sig)).toBe(false)
    expect(await verifyText((await newDeviceKeys()).publicKey, text, sig)).toBe(false)
    expect(await verifyText('garbage', text, sig)).toBe(false)
  })

  it('makes ids that fit where they are used', () => {
    expect(newDeviceId()).toMatch(/^[A-Za-z0-9_]{12}$/)
    expect(newGroupId()).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(newDataKey()).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
})

describe('merge', () => {
  const rec = (id: string, wall: number, device = 'devA', deleted = false, payload = `p${wall}`): SyncRecord => ({
    id,
    type: 'label',
    hlc: formatHlc({ wall, counter: 0, device }),
    deleted,
    payload
  })

  it('keeps the newer record and ignores the older', () => {
    const have = new Map([[recordKey(rec('a', T0)), rec('a', T0)]])
    expect(mergeIncoming(have, [rec('a', T0 - 1000)], T0).applied).toEqual([])
    expect(mergeIncoming(have, [rec('a', T0 + 1000)], T0 + 2000).applied).toHaveLength(1)
    expect(have.get('label:a')!.payload).toBe(`p${T0 + 1000}`)
  })

  it('lets a later deletion win over an earlier edit, and a later edit over a deletion', () => {
    const have = new Map<string, SyncRecord>()
    mergeIncoming(have, [rec('a', T0), rec('a', T0 + 10, 'devB', true)], T0 + 100)
    expect(have.get('label:a')!.deleted).toBe(true)
    mergeIncoming(have, [rec('a', T0 + 20, 'devA')], T0 + 100)
    expect(have.get('label:a')!.deleted).toBe(false)
  })

  it('breaks an exact tie by device, the same way everywhere', () => {
    const x = rec('a', T0, 'devA', false, 'from A')
    const y = rec('a', T0, 'devB', false, 'from B')
    expect(newer(x, y)).toBe(newer(y, x))
    expect(newer(x, y).payload).toBe('from B')
  })

  it('treats a record it already has as nothing new', () => {
    const r = rec('a', T0)
    const have = new Map([[recordKey(r), r]])
    expect(mergeIncoming(have, [{ ...r }], T0).applied).toEqual([])
  })

  it('refuses a record stamped far in the future, so it cannot pin a value forever', () => {
    const have = new Map<string, SyncRecord>()
    const r = mergeIncoming(have, [rec('a', T0 + MAX_CLOCK_DRIFT_MS * 3)], T0)
    expect(r).toEqual({ applied: [], refused: 1 })
    expect(have.size).toBe(0)
  })

  it('ends in the same state whatever order the records arrive in', () => {
    const records = [
      rec('a', T0 + 1, 'devA'),
      rec('a', T0 + 5, 'devB'),
      rec('a', T0 + 3, 'devA', true),
      rec('b', T0 + 2, 'devB'),
      rec('b', T0 + 2, 'devA'),
      rec('c', T0 + 9, 'devA', true)
    ]
    const run = (order: SyncRecord[]) => {
      const have = new Map<string, SyncRecord>()
      mergeIncoming(have, order, T0 + 1000)
      return JSON.stringify([...have].sort(([a], [b]) => (a < b ? -1 : 1)))
    }
    const expected = run(records)
    for (let i = 0; i < 40; i++) {
      const shuffled = [...records].sort(() => Math.random() - 0.5)
      expect(run(shuffled)).toBe(expected)
      // Delivering some twice changes nothing either.
      expect(run([...shuffled, ...shuffled.slice(0, 3)])).toBe(expected)
    }
  })

  it('accepts only the kinds of record that sync, with a real stamp', () => {
    expect(syncRecordSchema.safeParse(rec('a', T0)).success).toBe(true)
    expect(syncRecordSchema.safeParse({ ...rec('a', T0), type: 'message' }).success).toBe(false)
    expect(syncRecordSchema.safeParse({ ...rec('a', T0), hlc: 'yesterday' }).success).toBe(false)
    expect(syncRecordSchema.safeParse({ ...rec('a', T0), payload: 'x'.repeat(70_000) }).success).toBe(false)
  })
})

describe('protocol', () => {
  it('round-trips a pairing code, and says whether records are named by hash', async () => {
    const p = { server: 'https://sync.itmecasey.com', groupId: newGroupId(), key: newDataKey() }
    const code = encodePairing(p)
    expect(code.startsWith('imcsync1:')).toBe(true)
    // A code without a scheme is an older, plain-named group.
    expect(decodePairing(code)).toEqual({ ...p, ids: 'plain' })
    // Pasted with line breaks or spaces, as a recovery code might be.
    expect(decodePairing(` ${code.slice(0, 20)}\n${code.slice(20)} `)).toEqual({ ...p, ids: 'plain' })
    expect(decodePairing(encodePairing({ ...p, ids: 'opaque' }))).toEqual({ ...p, ids: 'opaque' })
  })

  it('names a record by a keyed hash that depends on the key, the kind and the id', async () => {
    const a = newDataKey()
    const real = 'me@x.co\u001fmsg-1@x'
    const id = await opaqueId(a, 'label', real)
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(id).not.toContain('me@x.co')
    expect(await opaqueId(a, 'label', real)).toBe(id)
    expect(await opaqueId(a, 'snooze', real)).not.toBe(id)
    expect(await opaqueId(newDataKey(), 'label', real)).not.toBe(id)
  })

  it('refuses a pairing code that is damaged or points somewhere unsafe', () => {
    const base = { server: 'https://sync.itmecasey.com', groupId: newGroupId(), key: newDataKey() }
    expect(decodePairing(encodePairing({ ...base, server: 'http://sync.itmecasey.com' }))).toBeNull()
    expect(decodePairing(encodePairing({ ...base, server: 'javascript:alert(1)' }))).toBeNull()
    expect(decodePairing(encodePairing({ ...base, key: 'short' }))).toBeNull()
    expect(decodePairing(encodePairing({ ...base, groupId: 'bad id!' }))).toBeNull()
    expect(decodePairing('imcsync1:%%%')).toBeNull()
    expect(decodePairing('something else')).toBeNull()
  })

  it('builds and reads the auth header', () => {
    const auth = { groupId: newGroupId(), deviceId: newDeviceId(), timestamp: T0, signature: 'A'.repeat(86) }
    expect(parseAuth(formatAuth(auth))).toEqual(auth)
    expect(parseAuth('Bearer abc')).toBeNull()
    expect(parseAuth(undefined)).toBeNull()
    expect(parseAuth(formatAuth(auth).replace('s=', 's=!'))).toBeNull()
  })

  it('limits a request to one batch', () => {
    expect(syncRequest.safeParse({ since: 0, records: [] }).data?.limit).toBe(500)
    expect(syncRequest.safeParse({ since: -1, records: [] }).success).toBe(false)
    const many = Array.from({ length: 501 }, (_, i) => ({ id: `r${i}`, type: 'label', hlc: formatHlc({ wall: T0, counter: i, device: 'devA' }), deleted: false, payload: 'x' }))
    expect(syncRequest.safeParse({ since: 0, records: many }).success).toBe(false)
  })
})
