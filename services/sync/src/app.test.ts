import { beforeEach, describe, expect, it } from 'vitest'
import {
  canonicalRequest,
  formatAuth,
  formatHlc,
  hashBody,
  joinHash,
  joinToken,
  mergeIncoming,
  newDataKey,
  newDeviceId,
  newDeviceKeys,
  newGroupId,
  openPayload,
  sealPayload,
  signText,
  type SyncRecord
} from '@imc/core'
import { handle, Limiter, type Deps, type Res } from './app'
import { MAX_DEVICES_PER_GROUP, SyncStore } from './store'

const T0 = Date.UTC(2026, 9, 26, 12, 0, 0)

let clock: { t: number }
let deps: Deps

beforeEach(() => {
  clock = { t: T0 }
  deps = { store: new SyncStore(':memory:'), limiter: new Limiter(() => clock.t), now: () => clock.t }
})

interface Device {
  id: string
  publicKey: string
  privateKey: string
  groupId: string
}

async function device(groupId: string): Promise<Device> {
  const keys = await newDeviceKeys()
  return { id: newDeviceId(), ...keys, groupId }
}

const unsigned = (method: string, path: string, body?: unknown, ip = '9.9.9.9') =>
  handle({ method, path, authorization: undefined, ip, bodyText: body === undefined ? '' : JSON.stringify(body) }, deps)

/** A request signed the way a real device signs it. */
async function call(d: Device, method: string, path: string, body?: unknown, over: { timestamp?: number; signPath?: string; bodyText?: string } = {}): Promise<Res> {
  const bodyText = over.bodyText ?? (body === undefined ? '' : JSON.stringify(body))
  const timestamp = over.timestamp ?? clock.t
  const signature = await signText(d.privateKey, canonicalRequest({ method, path: over.signPath ?? path, timestamp, bodyHash: await hashBody(bodyText) }))
  return handle({ method, path, authorization: formatAuth({ groupId: d.groupId, deviceId: d.id, timestamp, signature }), ip: '1.1.1.1', bodyText }, deps)
}

/** A group with its first device, as desktop creates it. */
async function newGroup() {
  const key = newDataKey()
  const groupId = newGroupId()
  const first = await device(groupId)
  const res = await unsigned('POST', '/v1/groups', { groupId, joinHash: await joinHash(await joinToken(key)), device: { id: first.id, publicKey: first.publicKey, name: 'Desktop' } })
  expect(res.status).toBe(201)
  return { key, groupId, first }
}

async function join(groupId: string, key: string, name = 'Phone', d?: Device): Promise<{ res: Res; device: Device }> {
  const dev = d ?? (await device(groupId))
  const res = await unsigned('POST', '/v1/groups/join', { groupId, joinToken: await joinToken(key), device: { id: dev.id, publicKey: dev.publicKey, name } })
  return { res, device: dev }
}

const record = async (key: string, id: string, wall: number, dev: string, contents: unknown, deleted = false): Promise<SyncRecord> => {
  const env = { id, type: 'label' as const, hlc: formatHlc({ wall, counter: 0, device: dev }), deleted }
  return { ...env, payload: await sealPayload(key, env, contents) }
}

describe('creating and joining a group', () => {
  it('creates a group, and refuses the same id again', async () => {
    const { groupId, first } = await newGroup()
    const again = await unsigned('POST', '/v1/groups', { groupId, joinHash: 'A'.repeat(43), device: { id: first.id, publicKey: first.publicKey, name: '' } })
    expect(again.status).toBe(409)
  })

  it('lets a device join with the proof derived from the key', async () => {
    const { groupId, key } = await newGroup()
    const { res, device: phone } = await join(groupId, key)
    expect(res.status).toBe(200)
    // Joining again from the same device is fine.
    expect((await join(groupId, key, 'Phone', phone)).res.status).toBe(200)
  })

  it('turns away a wrong proof and an unknown group in exactly the same way', async () => {
    const { groupId } = await newGroup()
    const wrong = await join(groupId, newDataKey())
    const unknown = await join(newGroupId(), newDataKey())
    expect(wrong.res).toEqual(unknown.res)
    expect(wrong.res.status).toBe(403)
  })

  it('refuses a device id that is already used with a different key, and a group past its device limit', async () => {
    const { groupId, key, first } = await newGroup()
    const clash = { ...(await device(groupId)), id: first.id }
    expect((await join(groupId, key, 'x', clash)).res.status).toBe(409)
    for (let i = 1; i < MAX_DEVICES_PER_GROUP; i++) expect((await join(groupId, key)).res.status).toBe(200)
    expect((await join(groupId, key)).res.status).toBe(409)
  })

  it('does not take the data key itself, only the proof', async () => {
    const { key, groupId } = await newGroup()
    const stored = deps.store.joinHash(groupId)!
    expect(stored).not.toContain(key)
    expect(stored).toBe(await joinHash(await joinToken(key)))
  })

  it('limits how many groups one address can create', async () => {
    for (let i = 0; i < 5; i++) await newGroup()
    const key = newDataKey()
    const d = await device('x')
    const res = await unsigned('POST', '/v1/groups', { groupId: newGroupId(), joinHash: await joinHash(await joinToken(key)), device: { id: d.id, publicKey: d.publicKey, name: '' } })
    expect(res.status).toBe(429)
  })

  it('stops taking new groups at the server ceiling', async () => {
    deps.maxGroups = 1
    await newGroup()
    const key = newDataKey()
    const d = await device('x')
    const res = await unsigned('POST', '/v1/groups', { groupId: newGroupId(), joinHash: await joinHash(await joinToken(key)), device: { id: d.id, publicKey: d.publicKey, name: '' } })
    expect(res.status).toBe(503)
  })

  it('rejects malformed bodies', async () => {
    expect((await unsigned('POST', '/v1/groups', { nope: 1 })).status).toBe(400)
    expect((await handle({ method: 'POST', path: '/v1/groups/join', authorization: undefined, ip: '1.1.1.1', bodyText: '{not json' }, deps)).status).toBe(400)
  })
})

describe('signed requests', () => {
  it('rejects a request with no signature, a wrong one, a stale one, or for another path or body', async () => {
    const { groupId, first } = await newGroup()
    expect((await unsigned('GET', '/v1/devices')).status).toBe(401)
    expect((await call(first, 'GET', '/v1/devices')).status).toBe(200)
    const other = await device(groupId)
    expect((await call({ ...other, id: first.id }, 'GET', '/v1/devices')).status).toBe(401)
    expect((await call(first, 'GET', '/v1/devices', undefined, { timestamp: clock.t - 6 * 60_000 })).status).toBe(401)
    expect((await call(first, 'GET', '/v1/devices', undefined, { timestamp: clock.t + 6 * 60_000 })).status).toBe(401)
    // A captured signature for one request cannot be used for another.
    expect((await call(first, 'POST', '/v1/sync', { since: 0, records: [] }, { signPath: '/v1/devices' })).status).toBe(401)
    expect((await call(first, 'POST', '/v1/sync', { since: 0, records: [] }, { bodyText: '{"since":0,"records":[],"limit":1}' })).status).toBe(200)
  })

  it('rejects a body changed after signing', async () => {
    const { first } = await newGroup()
    const bodyText = JSON.stringify({ since: 0, records: [] })
    const timestamp = clock.t
    const signature = await signText(first.privateKey, canonicalRequest({ method: 'POST', path: '/v1/sync', timestamp, bodyHash: await hashBody(bodyText) }))
    const res = await handle(
      { method: 'POST', path: '/v1/sync', authorization: formatAuth({ groupId: first.groupId, deviceId: first.id, timestamp, signature }), ip: '1.1.1.1', bodyText: JSON.stringify({ since: 0, records: [], limit: 1 }) },
      deps
    )
    expect(res.status).toBe(401)
  })

  it('does not let a device of one group into another', async () => {
    const a = await newGroup()
    const b = await newGroup()
    const intruder = { ...a.first, groupId: b.groupId }
    expect((await call(intruder, 'POST', '/v1/sync', { since: 0, records: [] })).status).toBe(401)
  })

  it('knows its routes and methods', async () => {
    const { first } = await newGroup()
    expect((await call(first, 'GET', '/v1/other')).status).toBe(404)
    expect((await call(first, 'GET', '/v1/sync')).status).toBe(405)
    expect((await call(first, 'POST', '/v1/devices')).status).toBe(405)
    expect((await unsigned('GET', '/healthz')).status).toBe(200)
  })
})

describe('syncing records', () => {
  it('carries a record from one device to another, still encrypted', async () => {
    const { groupId, key, first } = await newGroup()
    const { device: phone } = await join(groupId, key)
    const r = await record(key, 'label-1', T0 - 1000, first.id, { name: 'Sponsors' })
    const pushed = (await call(first, 'POST', '/v1/sync', { since: 0, records: [r] })).json as { seq: number; refused: number }
    expect(pushed.refused).toBe(0)

    const pulled = (await call(phone, 'POST', '/v1/sync', { since: 0, records: [] })).json as { records: (SyncRecord & { seq: number })[]; seq: number; more: boolean }
    expect(pulled.records).toHaveLength(1)
    expect(pulled.records[0]!.payload).toBe(r.payload)
    expect(pulled.records[0]!.payload).not.toContain('Sponsors')
    expect(await openPayload(key, pulled.records[0]!, pulled.records[0]!.payload)).toEqual({ name: 'Sponsors' })

    // Nothing new after that.
    const again = (await call(phone, 'POST', '/v1/sync', { since: pulled.seq, records: [] })).json as { records: unknown[] }
    expect(again.records).toEqual([])
  })

  it('keeps the newer version, gives a replacement a new number, and ignores an older one', async () => {
    const { groupId, key, first } = await newGroup()
    const { device: phone } = await join(groupId, key)
    const v1 = await record(key, 'label-1', T0 - 3000, first.id, { name: 'one' })
    const v2 = await record(key, 'label-1', T0 - 2000, phone.id, { name: 'two' })
    const old = await record(key, 'label-1', T0 - 4000, first.id, { name: 'zero' })
    const s1 = (await call(first, 'POST', '/v1/sync', { since: 0, records: [v1] })).json as { seq: number }
    await call(phone, 'POST', '/v1/sync', { since: 0, records: [v2] })
    await call(first, 'POST', '/v1/sync', { since: 0, records: [old] })

    const after = (await call(first, 'POST', '/v1/sync', { since: s1.seq, records: [] })).json as { records: SyncRecord[] }
    expect(after.records).toHaveLength(1)
    expect(after.records[0]!.hlc).toBe(v2.hlc)
    expect(deps.store.recordCount(groupId)).toBe(1)
  })

  it('passes a deletion along like any other change', async () => {
    const { groupId, key, first } = await newGroup()
    const { device: phone } = await join(groupId, key)
    const live = await record(key, 'label-1', T0 - 3000, first.id, { name: 'x' })
    const gone = await record(key, 'label-1', T0 - 1000, first.id, null, true)
    await call(first, 'POST', '/v1/sync', { since: 0, records: [live] })
    const got = (await call(phone, 'POST', '/v1/sync', { since: 0, records: [] })).json as { seq: number }
    await call(first, 'POST', '/v1/sync', { since: 0, records: [gone] })
    const next = (await call(phone, 'POST', '/v1/sync', { since: got.seq, records: [] })).json as { records: SyncRecord[] }
    expect(next.records[0]!.deleted).toBe(true)
  })

  it('refuses a record stamped far in the future', async () => {
    const { first, key } = await newGroup()
    const bad = await record(key, 'label-1', T0 + 3 * 86_400_000, first.id, { name: 'x' })
    const res = (await call(first, 'POST', '/v1/sync', { since: 0, records: [bad] })).json as { refused: number; records: unknown[] }
    expect(res.refused).toBe(1)
    expect(res.records).toEqual([])
  })

  it('pages through a long list', async () => {
    const { groupId, key, first } = await newGroup()
    const records = await Promise.all(Array.from({ length: 7 }, (_, i) => record(key, `label-${i}`, T0 - 1000 + i, first.id, { i })))
    await call(first, 'POST', '/v1/sync', { since: 0, records })
    const seen: string[] = []
    let since = 0
    for (let guard = 0; guard < 10; guard++) {
      const page = (await call(first, 'POST', '/v1/sync', { since, records: [], limit: 3 })).json as { records: SyncRecord[]; seq: number; more: boolean }
      seen.push(...page.records.map((r) => r.id))
      since = page.seq
      if (!page.more) break
    }
    expect(seen.sort()).toEqual(records.map((r) => r.id).sort())
    expect(deps.store.recordCount(groupId)).toBe(7)
  })

  it('keeps groups apart', async () => {
    const a = await newGroup()
    const b = await newGroup()
    await call(a.first, 'POST', '/v1/sync', { since: 0, records: [await record(a.key, 'label-1', T0 - 1000, a.first.id, { name: 'A' })] })
    const seen = (await call(b.first, 'POST', '/v1/sync', { since: 0, records: [] })).json as { records: unknown[] }
    expect(seen.records).toEqual([])
  })

  it('stops accepting new records at the group ceiling but still takes updates', async () => {
    const { groupId, key, first } = await newGroup()
    const a = await record(key, 'label-a', T0 - 2000, first.id, 1)
    await call(first, 'POST', '/v1/sync', { since: 0, records: [a] })
    const store = deps.store as unknown as { recordCount: (g: string) => number }
    const real = store.recordCount.bind(store)
    store.recordCount = (g) => (g === groupId ? 20_000 : real(g))
    const fresh = await record(key, 'label-b', T0 - 1000, first.id, 2)
    const update = await record(key, 'label-a', T0 - 1000, first.id, 3)
    const res = (await call(first, 'POST', '/v1/sync', { since: 0, records: [fresh, update] })).json as { refused: number }
    expect(res.refused).toBe(1)
  })

  it('converges two devices that edit while apart, using the shared merge', async () => {
    const { groupId, key, first } = await newGroup()
    const { device: phone } = await join(groupId, key)
    const desktopHas = new Map<string, SyncRecord>()
    const phoneHas = new Map<string, SyncRecord>()
    const edit1 = await record(key, 'label-1', T0 - 5000, first.id, { name: 'desktop rename' })
    const edit2 = await record(key, 'label-1', T0 - 4000, phone.id, { name: 'phone rename' })
    const other = await record(key, 'label-2', T0 - 4500, first.id, { name: 'only on desktop' })
    mergeIncoming(desktopHas, [edit1, other], T0)
    mergeIncoming(phoneHas, [edit2], T0)

    const dPull = (await call(first, 'POST', '/v1/sync', { since: 0, records: [...desktopHas.values()] })).json as { records: SyncRecord[] }
    const pPull = (await call(phone, 'POST', '/v1/sync', { since: 0, records: [...phoneHas.values()] })).json as { records: SyncRecord[] }
    mergeIncoming(desktopHas, [...dPull.records, ...pPull.records], T0)
    mergeIncoming(phoneHas, [...dPull.records, ...pPull.records], T0)
    const final = (await call(first, 'POST', '/v1/sync', { since: 0, records: [] })).json as { records: SyncRecord[] }
    mergeIncoming(desktopHas, final.records, T0)
    mergeIncoming(phoneHas, final.records, T0)

    // Records that came from the server also carry its running number; what matters is the same content.
    const same = (m: Map<string, SyncRecord>) => [...m].map(([k, r]) => [k, r.hlc, r.deleted, r.payload]).sort()
    expect(same(desktopHas)).toEqual(same(phoneHas))
    expect(desktopHas.size).toBe(2)
    expect(await openPayload(key, desktopHas.get('label:label-1')!, desktopHas.get('label:label-1')!.payload)).toEqual({ name: 'phone rename' })
  })
})

describe('devices', () => {
  it('lists devices and marks the caller', async () => {
    const { groupId, key, first } = await newGroup()
    // Devices are listed in the order they joined; give the phone a later time than the desktop.
    clock.t += 1000
    const { device: phone } = await join(groupId, key, 'Pixel 9')
    const list = (await call(phone, 'GET', '/v1/devices')).json as { devices: { id: string; name: string; current: boolean }[] }
    expect(list.devices.map((d) => [d.name, d.current])).toEqual([['Desktop', false], ['Pixel 9', true]])
    expect(JSON.stringify(list)).not.toContain(first.publicKey)
  })

  it('locks a removed device out at once', async () => {
    const { groupId, key, first } = await newGroup()
    const { device: phone } = await join(groupId, key)
    expect((await call(first, 'DELETE', `/v1/devices/${phone.id}`)).status).toBe(200)
    expect((await call(phone, 'POST', '/v1/sync', { since: 0, records: [] })).status).toBe(401)
    expect((await call(first, 'DELETE', `/v1/devices/${phone.id}`)).status).toBe(404)
  })

  it('deletes the whole group when its last device is removed', async () => {
    const { groupId, key, first } = await newGroup()
    await call(first, 'POST', '/v1/sync', { since: 0, records: [await record(key, 'label-1', T0 - 1000, first.id, 1)] })
    expect((await call(first, 'DELETE', `/v1/devices/${first.id}`)).status).toBe(200)
    expect(deps.store.recordCount(groupId)).toBe(0)
    expect(deps.store.joinHash(groupId)).toBeNull()
  })

  it('limits how fast one device can ask', async () => {
    const { first } = await newGroup()
    let last = 200
    for (let i = 0; i < 125; i++) last = (await call(first, 'GET', '/v1/devices')).status
    expect(last).toBe(429)
    clock.t += 61_000
    expect((await call(first, 'GET', '/v1/devices')).status).toBe(200)
  })
})
