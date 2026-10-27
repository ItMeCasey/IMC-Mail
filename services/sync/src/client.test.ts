import { beforeEach, describe, expect, it } from 'vitest'
import { SyncClient, SyncError, type SyncAdapter, type SyncItem, type SyncSecrets, type SyncStorage, type SyncType } from '@imc/core'
import { handle, Limiter, type Deps } from './app'
import { SyncStore } from './store'

const SERVER = 'https://sync.test'
let clock: { t: number }
let deps: Deps
/** Lets a test change what the server sends back, to play a misbehaving server. */
let tamper: ((path: string, json: any) => any) | null
let offline: boolean

beforeEach(() => {
  clock = { t: Date.UTC(2026, 9, 26, 12, 0, 0) }
  deps = { store: new SyncStore(':memory:'), limiter: new Limiter(() => clock.t), now: () => clock.t }
  tamper = null
  offline = false
})

/** The real server logic, reached the way a device reaches it: through fetch. */
const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
  if (offline) throw new TypeError('fetch failed')
  const path = new URL(String(url)).pathname
  const headers = (init?.headers ?? {}) as Record<string, string>
  const out = await handle({ method: init?.method ?? 'GET', path, authorization: headers['Authorization'], ip: '1.1.1.1', bodyText: String(init?.body ?? '') }, deps)
  return new Response(JSON.stringify(tamper ? tamper(path, out.json) : out.json), { status: out.status })
}) as typeof fetch

function memoryStorage(): SyncStorage & { kv: Map<string, string>; all: Map<string, SyncItem> } {
  const kv = new Map<string, string>()
  const all = new Map<string, SyncItem>()
  return {
    kv,
    all,
    get: (k) => kv.get(k) ?? null,
    set: (k, v) => void kv.set(k, v),
    remove: (k) => void kv.delete(k),
    item: (t, id) => all.get(`${t}:${id}`) ?? null,
    items: (t) => [...all.values()].filter((i) => i.type === t),
    putItem: (i) => void all.set(`${i.type}:${i.id}`, i),
    clear: () => {
      kv.clear()
      all.clear()
    }
  }
}

function memorySecrets(): SyncSecrets & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return { map, get: async (k) => map.get(k), set: async (k, v) => void map.set(k, v), delete: async (k) => void map.delete(k) }
}

/** A kind of data held in a Map, standing in for an app's database table. */
function table(type: SyncType, opts: { unique?: boolean; waiting?: { ready: boolean } } = {}) {
  const rows = new Map<string, { name: string }>()
  const adapter: SyncAdapter = {
    type,
    list: () => [...rows].map(([id, data]) => ({ id, data })),
    parse: (d) => (d && typeof d === 'object' && typeof (d as { name?: unknown }).name === 'string' ? { name: (d as { name: string }).name } : null),
    upsert: (id, data) => {
      if (opts.waiting && !opts.waiting.ready) return 'later'
      const d = data as { name: string }
      if (opts.unique && [...rows].some(([other, r]) => other !== id && r.name.toLowerCase() === d.name.toLowerCase())) return false
      rows.set(id, d)
      return true
    },
    remove: (id) => void rows.delete(id)
  }
  return { rows, adapter }
}

function makeDevice(name: string) {
  const storage = memoryStorage()
  const secrets = memorySecrets()
  const labels = table('label', { unique: true })
  const rules = table('rule')
  const client = new SyncClient({ storage, secrets, adapters: [labels.adapter, rules.adapter], fetchFn, now: () => clock.t })
  return { name, storage, secrets, labels, rules, client }
}

/** Two devices in one group: the desktop makes it, the phone joins from the pairing code. */
async function pair() {
  const desktop = makeDevice('Desktop')
  const phone = makeDevice('Phone')
  const p = await desktop.client.enable(SERVER, 'Desktop')
  // Devices are listed in the order they joined.
  clock.t += 1000
  await phone.client.join(desktop.client.pairingCode(p), 'Phone')
  return { desktop, phone, pairing: p }
}

const tick = () => (clock.t += 1000)

describe('setting up', () => {
  it('turns sync on and gives a pairing code that opens the group', async () => {
    const { desktop, phone, pairing } = await pair()
    expect(desktop.client.status()).toMatchObject({ paired: true, server: SERVER, deviceName: 'Desktop', error: null, revoked: false })
    expect(phone.client.status().paired).toBe(true)
    expect(await desktop.client.pairing()).toEqual(pairing)
    const list = await phone.client.devices()
    expect(list.map((d) => [d.name, d.current])).toEqual([['Desktop', false], ['Phone', true]])
  })

  it('keeps the key and private key in the secret store, not in plain settings', async () => {
    const { desktop, pairing } = await pair()
    expect([...desktop.secrets.map.values()]).toContain(pairing.key)
    expect(JSON.stringify([...desktop.storage.kv])).not.toContain(pairing.key)
    expect(desktop.secrets.map.size).toBe(2)
  })

  it('returns the same pairing when turned on twice', async () => {
    const { desktop, pairing } = await pair()
    expect(await desktop.client.enable(SERVER, 'Other name')).toEqual(pairing)
    expect(deps.store.groupCount()).toBe(1)
  })

  it('refuses a bad pairing code and an already-synced device', async () => {
    const { desktop } = await pair()
    await expect(makeDevice('X').client.join('nonsense', 'X')).rejects.toThrow('not a valid pairing code')
    const code = desktop.client.pairingCode((await desktop.client.pairing())!)
    await expect(desktop.client.join(code, 'again')).rejects.toThrow('already syncing')
  })

  it('says so when the server cannot be reached, and stays unpaired', async () => {
    offline = true
    const d = makeDevice('Desktop')
    await expect(d.client.enable(SERVER, 'Desktop')).rejects.toThrow(SyncError)
    await expect(d.client.enable(SERVER, 'Desktop')).rejects.toThrow("Can't reach")
    expect(d.client.status().paired).toBe(false)
  })

  it('a wrong key cannot join', async () => {
    const { pairing } = await pair()
    const intruder = makeDevice('Intruder')
    const forged = new SyncClient({ storage: memoryStorage(), secrets: memorySecrets(), adapters: [], fetchFn }).pairingCode({ ...pairing, key: 'A'.repeat(43) })
    await expect(intruder.client.join(forged, 'Intruder')).rejects.toThrow('Not allowed')
    expect(intruder.client.status().paired).toBe(false)
  })
})

describe('syncing', () => {
  it('carries a new item, a rename and a deletion across', async () => {
    const { desktop, phone } = await pair()
    desktop.labels.rows.set('l1', { name: 'Sponsors' })
    await desktop.client.syncNow()
    await phone.client.syncNow()
    expect(phone.labels.rows.get('l1')).toEqual({ name: 'Sponsors' })

    tick()
    phone.labels.rows.set('l1', { name: 'Brand deals' })
    await phone.client.syncNow()
    await desktop.client.syncNow()
    expect(desktop.labels.rows.get('l1')).toEqual({ name: 'Brand deals' })

    tick()
    desktop.labels.rows.delete('l1')
    await desktop.client.syncNow()
    await phone.client.syncNow()
    expect(phone.labels.rows.size).toBe(0)
  })

  it('sends nothing the second time when nothing changed', async () => {
    const { desktop, phone } = await pair()
    desktop.labels.rows.set('l1', { name: 'A' })
    desktop.rules.rows.set('r1', { name: 'Rule' })
    await desktop.client.syncNow()
    await phone.client.syncNow()
    const before = deps.store.pull((await desktop.client.pairing())!.groupId, 0, 500).seq
    await desktop.client.syncNow()
    await phone.client.syncNow()
    await desktop.client.syncNow()
    expect(deps.store.pull((await desktop.client.pairing())!.groupId, 0, 500).seq).toBe(before)
  })

  it('brings a new device up to date with everything already there', async () => {
    const { desktop, phone } = await pair()
    for (let i = 0; i < 7; i++) desktop.labels.rows.set(`l${i}`, { name: `Label ${i}` })
    desktop.rules.rows.set('r1', { name: 'Rule' })
    await desktop.client.syncNow()
    await phone.client.syncNow()
    expect(phone.labels.rows.size).toBe(7)
    expect(phone.rules.rows.size).toBe(1)
  })

  // A change is stamped when the device notices it (a few seconds after the edit while online), so of two
  // edits made while apart, the one that reaches the server later is the one that stands.
  it('settles two edits made while apart on the one sent later, on both devices', async () => {
    const { desktop, phone } = await pair()
    desktop.labels.rows.set('l1', { name: 'Start' })
    await desktop.client.syncNow()
    await phone.client.syncNow()

    tick()
    desktop.labels.rows.set('l1', { name: 'Desktop edit' })
    tick()
    phone.labels.rows.set('l1', { name: 'Phone edit' })
    await desktop.client.syncNow()
    tick()
    await phone.client.syncNow()
    await desktop.client.syncNow()
    expect(desktop.labels.rows.get('l1')).toEqual({ name: 'Phone edit' })
    expect(phone.labels.rows.get('l1')).toEqual({ name: 'Phone edit' })
  })

  it('does not change what the other device made while it was away if the clocks disagree', async () => {
    const { desktop, phone } = await pair()
    desktop.labels.rows.set('l1', { name: 'A' })
    await desktop.client.syncNow()
    await phone.client.syncNow()
    // The phone's clock runs a minute behind; its later edit still wins, because it saw the earlier one first.
    clock.t -= 60_000
    phone.labels.rows.set('l1', { name: 'B' })
    await phone.client.syncNow()
    await desktop.client.syncNow()
    expect(desktop.labels.rows.get('l1')).toEqual({ name: 'B' })
  })

  it('does not delete on the other device when it simply could not store an item', async () => {
    const { desktop, phone } = await pair()
    phone.labels.rows.set('p1', { name: 'Taxes' })
    desktop.labels.rows.set('d1', { name: 'taxes' })
    await desktop.client.syncNow()
    await phone.client.syncNow()
    await desktop.client.syncNow()
    await phone.client.syncNow()
    // Each device kept its own, since the names clash; neither deleted the other's.
    expect(desktop.labels.rows.has('d1')).toBe(true)
    expect(phone.labels.rows.has('p1')).toBe(true)
  })

  it('ignores a record it cannot open and one with unusable contents, and carries on', async () => {
    const { desktop, phone } = await pair()
    desktop.labels.rows.set('l1', { name: 'Good' })
    await desktop.client.syncNow()
    tamper = (path, json) => {
      if (path !== '/v1/sync' || !json.records) return json
      return { ...json, records: json.records.map((r: any) => ({ ...r, payload: r.payload.slice(0, 40) + 'AAAA' + r.payload.slice(44) })) }
    }
    await phone.client.syncNow()
    expect(phone.labels.rows.size).toBe(0)
    expect(phone.client.status().error).toBeNull()
    tamper = null
    await phone.client.syncNow()
    expect(phone.labels.rows.size).toBe(0) // the record was already passed over; it comes again only when changed
    tick()
    desktop.labels.rows.set('l1', { name: 'Good again' })
    await desktop.client.syncNow()
    await phone.client.syncNow()
    expect(phone.labels.rows.get('l1')).toEqual({ name: 'Good again' })
  })

  it('does not read a kind of data it has no adapter for', async () => {
    const { desktop, phone } = await pair()
    const lonely = new SyncClient({ storage: desktop.storage, secrets: desktop.secrets, adapters: [desktop.labels.adapter], fetchFn, now: () => clock.t })
    desktop.rules.rows.set('r1', { name: 'Rule' })
    desktop.labels.rows.set('l1', { name: 'A' })
    await desktop.client.syncNow()
    await phone.client.syncNow()
    expect(phone.rules.rows.size).toBe(1)
    await lonely.syncNow()
    expect(lonely.status().error).toBeNull()
  })

  it('does not treat an unreadable kind of data as a deletion', async () => {
    const { desktop, phone } = await pair()
    desktop.rules.rows.set('r1', { name: 'Rule' })
    await desktop.client.syncNow()
    const real = desktop.rules.adapter.list
    desktop.rules.adapter.list = () => {
      throw new Error('database busy')
    }
    await desktop.client.syncNow()
    desktop.rules.adapter.list = real
    await phone.client.syncNow()
    expect(phone.rules.rows.size).toBe(1)
  })

  it('reports a network failure and recovers on the next round', async () => {
    const { desktop } = await pair()
    desktop.labels.rows.set('l1', { name: 'A' })
    offline = true
    const failed = await desktop.client.syncNow()
    expect(failed.error).toContain("Can't reach")
    offline = false
    const ok = await desktop.client.syncNow()
    expect(ok.error).toBeNull()
    expect(ok.lastSyncAt).toBe(clock.t)
    expect(deps.store.recordCount((await desktop.client.pairing())!.groupId)).toBe(1)
  })

  it('does not run two rounds at once', async () => {
    const { desktop } = await pair()
    desktop.labels.rows.set('l1', { name: 'A' })
    const a = desktop.client.syncNow()
    const b = desktop.client.syncNow()
    expect(a).toBe(b)
    await a
    expect(desktop.client.status().syncing).toBe(false)
  })
})

describe('items that wait for an account or message', () => {
  const lateDevice = () => {
    const storage = memoryStorage()
    const waiting = { ready: false }
    const rules = table('rule', { waiting })
    const client = new SyncClient({ storage, secrets: memorySecrets(), adapters: [rules.adapter], fetchFn, now: () => clock.t })
    return { storage, waiting, rules, client }
  }

  it('applies them once what they wait for is there, when asked to look again', async () => {
    const { desktop } = await pair()
    desktop.rules.rows.set('r1', { name: 'Needs the account' })
    await desktop.client.syncNow()
    const code = desktop.client.pairingCode((await desktop.client.pairing())!)
    const late = lateDevice()
    await late.client.join(code, 'Late')
    await late.client.syncNow()
    expect(late.rules.rows.size).toBe(0)
    expect(late.client.status().error).toBeNull()

    late.waiting.ready = true
    await late.client.syncNow() // nothing new at the server: it is not asked again yet
    expect(late.rules.rows.size).toBe(0)
    late.client.rewind()
    await late.client.syncNow()
    expect(late.rules.rows.get('r1')).toEqual({ name: 'Needs the account' })
  })

  it('asks again by itself after a while, and only while something is waiting', async () => {
    const { desktop } = await pair()
    desktop.rules.rows.set('r1', { name: 'Later' })
    await desktop.client.syncNow()
    const late = lateDevice()
    await late.client.join(desktop.client.pairingCode((await desktop.client.pairing())!), 'Late')
    await late.client.syncNow()
    late.waiting.ready = true
    clock.t += 5 * 60_000
    await late.client.syncNow()
    expect(late.rules.rows.size).toBe(0)
    clock.t += 11 * 60_000
    await late.client.syncNow()
    expect(late.rules.rows.size).toBe(1)
    // Nothing waits any more, so it does not keep asking for everything.
    expect(late.storage.get('deferred')).toBe('0')
    const seq = late.storage.get('since')
    clock.t += 60 * 60_000
    await late.client.syncNow()
    expect(late.storage.get('since')).toBe(seq)
  })

  it('does not send an item it could not store back as a deletion', async () => {
    const { desktop } = await pair()
    desktop.rules.rows.set('r1', { name: 'Keep me' })
    await desktop.client.syncNow()
    const late = lateDevice()
    await late.client.join(desktop.client.pairingCode((await desktop.client.pairing())!), 'Late')
    await late.client.syncNow()
    await late.client.syncNow()
    await desktop.client.syncNow()
    expect(desktop.rules.rows.size).toBe(1)
  })
})

describe('removing devices', () => {
  it('locks a removed device out and tells it', async () => {
    const { desktop, phone } = await pair()
    const [, p] = await desktop.client.devices()
    await desktop.client.removeDevice(p!.id)
    const status = await phone.client.syncNow()
    expect(status.revoked).toBe(true)
    expect(status.error).toContain('removed from sync')
    // It stops trying until sync is turned on again.
    expect((await phone.client.syncNow()).syncing).toBe(false)
  })

  it('turning sync off removes this device at the server and wipes the keys here, but keeps the data', async () => {
    const { desktop, phone } = await pair()
    phone.labels.rows.set('l1', { name: 'Mine' })
    await phone.client.disable()
    expect(phone.client.status().paired).toBe(false)
    expect(phone.secrets.map.size).toBe(0)
    expect(phone.labels.rows.size).toBe(1)
    expect((await desktop.client.devices()).map((d) => d.name)).toEqual(['Desktop'])
  })

  it('can turn sync off even when the server cannot be reached', async () => {
    const { phone } = await pair()
    offline = true
    await phone.client.disable()
    expect(phone.client.status().paired).toBe(false)
    expect(phone.secrets.map.size).toBe(0)
  })

  it('can start again as a new device after turning sync off', async () => {
    const { desktop, phone } = await pair()
    await phone.client.disable()
    const code = desktop.client.pairingCode((await desktop.client.pairing())!)
    await phone.client.join(code, 'Phone again')
    expect(phone.client.status()).toMatchObject({ paired: true, revoked: false, deviceName: 'Phone again' })
  })
})

describe('what the server can see', () => {
  const ids = async (pairing: { groupId: string }) => deps.store.pull(pairing.groupId, 0, 500).records.map((r) => r.id)

  it('names records by a hash, so an account address and Message-ID never reach the server', async () => {
    const { desktop, phone, pairing } = await pair()
    const real = 'me@example.com\u001f<abc123@mail.example.com>'
    desktop.rules.rows.set(real, { name: 'Snoozed' })
    await desktop.client.syncNow()
    const seen = await ids(pairing)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(JSON.stringify(deps.store.pull(pairing.groupId, 0, 500).records)).not.toContain('me@example.com')
    // The other device still gets the real id.
    await phone.client.syncNow()
    expect(phone.rules.rows.get(real)).toEqual({ name: 'Snoozed' })
  })

  it('carries a deletion of such a record across', async () => {
    const { desktop, phone } = await pair()
    const real = 'me@example.com\u001f<abc123@mail.example.com>'
    desktop.rules.rows.set(real, { name: 'x' })
    await desktop.client.syncNow()
    await phone.client.syncNow()
    tick()
    desktop.rules.rows.delete(real)
    await desktop.client.syncNow()
    await phone.client.syncNow()
    expect(phone.rules.rows.size).toBe(0)
  })

  it('keeps working with a group made before records were named by hash', async () => {
    const desktop = makeDevice('Desktop')
    const phone = makeDevice('Phone')
    const p = await desktop.client.enable(SERVER, 'Desktop')
    // Make it an older group on both devices: the pairing code carries no scheme, and the desktop uses real ids.
    desktop.storage.kv.set('ids', 'plain')
    tick()
    await phone.client.join(desktop.client.pairingCode({ server: p.server, groupId: p.groupId, key: p.key }), 'Phone')
    expect(phone.storage.kv.get('ids')).toBe('plain')
    desktop.rules.rows.set('me@example.com\u001fid', { name: 'Old style' })
    await desktop.client.syncNow()
    expect(await ids(p)).toEqual(['me@example.com\u001fid'])
    await phone.client.syncNow()
    expect(phone.rules.rows.get('me@example.com\u001fid')).toEqual({ name: 'Old style' })
  })
})

describe('replacing the key', () => {
  it('ends the old group, starts a new one with a new key, and sends everything again', async () => {
    const { desktop, phone, pairing } = await pair()
    desktop.labels.rows.set('l1', { name: 'Sponsors' })
    await desktop.client.syncNow()
    const fresh = await desktop.client.rotate()
    expect(fresh.key).not.toBe(pairing.key)
    expect(fresh.groupId).not.toBe(pairing.groupId)
    expect(deps.store.groupCount()).toBe(1)
    expect(deps.store.pull(pairing.groupId, 0, 500).records).toEqual([])
    expect(desktop.client.status().paired).toBe(true)

    tick()
    await desktop.client.syncNow()
    expect(deps.store.pull(fresh.groupId, 0, 500).records).toHaveLength(1)

    // The phone was in the old group, so it is told it was removed, and rejoins with the new code.
    await phone.client.syncNow()
    expect(phone.client.status().revoked).toBe(true)
    await phone.client.disable()
    await phone.client.join(desktop.client.pairingCode(fresh), 'Phone')
    await phone.client.syncNow()
    expect(phone.labels.rows.get('l1')).toEqual({ name: 'Sponsors' })
  })

  it('leaves the old group working when the new one cannot be made', async () => {
    const { desktop, pairing } = await pair()
    offline = true
    await expect(desktop.client.rotate()).rejects.toThrow("Can't reach")
    offline = false
    expect(desktop.client.status().paired).toBe(true)
    expect(await desktop.client.pairing()).toEqual(pairing)
    expect(deps.store.groupCount()).toBe(1)
    await expect(desktop.client.syncNow()).resolves.toMatchObject({ error: null })
  })

  it('moves a group made before hashed names onto them', async () => {
    const desktop = makeDevice('Desktop')
    const p = await desktop.client.enable(SERVER, 'Desktop')
    desktop.storage.kv.set('ids', 'plain')
    desktop.rules.rows.set('me@example.com\u001fid', { name: 'x' })
    await desktop.client.syncNow()
    const fresh = await desktop.client.rotate()
    expect(fresh.ids).toBe('opaque')
    await desktop.client.syncNow()
    const after = deps.store.pull(fresh.groupId, 0, 500).records
    expect(after).toHaveLength(1)
    expect(after[0]!.id).not.toContain('me@example.com')
    expect(p.groupId).not.toBe(fresh.groupId)
  })
})
