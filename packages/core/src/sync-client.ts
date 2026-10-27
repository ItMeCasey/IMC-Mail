import { compareHlc, receiveHlc, tickHlc } from './sync-clock'
import {
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
  signText
} from './sync-crypto'
import { MAX_PAYLOAD_CHARS, recordKey, syncTypes, type SyncRecord, type SyncType } from './sync-merge'
import { canonicalRequest, decodePairing, encodePairing, formatAuth, syncResponse, type Pairing } from './sync-protocol'

// The device side of sync, shared by the desktop and the phone. It knows nothing about SQLite or any
// particular app: each kind of data is reached through an adapter, and its own bookkeeping goes through
// a small storage interface. It finds what changed here by comparing what is there now with what it
// last synced, so the app's own code never has to say "this changed".

/** One kind of synced data, as this app stores it. */
export interface SyncAdapter {
  type: SyncType
  /** Every item of this kind that exists here, with its contents. Contents must be plain JSON. */
  list(): { id: string; data: unknown }[]
  /** Checks contents that came from another device. Returns what to store, or null if it cannot be used. */
  parse(data: unknown): unknown | null
  /**
   * Creates or updates an item. True when stored. False when it cannot be stored (a name that is already
   * taken, say). 'later' when it cannot be stored yet but may be: it belongs to an account or message this
   * device does not have yet. Those are asked for again from the start after a while, or when asked for.
   */
  upsert(id: string, data: unknown): boolean | 'later'
  remove(id: string): void
}

/** What was synced last for one item: lets the next round tell a change here from one that arrived. */
export interface SyncItem {
  type: SyncType
  id: string
  hash: string
  hlc: string
  deleted: boolean
}

export interface SyncStorage {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
  item(type: SyncType, id: string): SyncItem | null
  items(type: SyncType): SyncItem[]
  putItem(item: SyncItem): void
  /** Forgets everything: settings and items. */
  clear(): void
}

export interface SyncSecrets {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

export interface SyncStatus {
  paired: boolean
  server: string
  deviceName: string
  lastSyncAt: number | null
  error: string | null
  syncing: boolean
  /** Another device removed this one. Turn sync on again to rejoin. */
  revoked: boolean
}

export interface SyncDevice {
  id: string
  name: string
  createdAt: number
  lastSeen: number
  current: boolean
}

/** A failure with a message that can be shown to the person as it is. */
export class SyncError extends Error {}

const KEY_SECRET = 'sync-data-key'
const PRIVATE_SECRET = 'sync-device-key'
/** A change found here, waiting to be sent: the record, and what to remember about it once the server has it. */
interface Pending {
  record: SyncRecord
  item: SyncItem
}

/** One push stays well under the server's request size limit. */
const MAX_PUSH_RECORDS = 200
const MAX_PUSH_CHARS = 1_500_000
/** How often items that are waiting for an account or message are asked for again. */
const REWIND_EVERY_MS = 15 * 60_000

/** JSON with object keys in sorted order, so equal data always gives equal text. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export class SyncClient {
  private running: Promise<SyncStatus> | null = null
  /** How many items in this round could not be stored yet. */
  private deferred = 0
  private byType: Map<SyncType, SyncAdapter>

  constructor(
    private d: {
      storage: SyncStorage
      secrets: SyncSecrets
      adapters: SyncAdapter[]
      fetchFn?: typeof fetch
      now?: () => number
      /** Called after records from another device changed something here. */
      onApplied?: () => void
    }
  ) {
    this.byType = new Map(d.adapters.map((a) => [a.type, a]))
  }

  private now = () => (this.d.now ?? Date.now)()
  private fetchFn = () => this.d.fetchFn ?? fetch

  status(): SyncStatus {
    const s = this.d.storage
    const last = s.get('lastSyncAt')
    return {
      paired: s.get('groupId') !== null,
      server: s.get('server') ?? '',
      deviceName: s.get('deviceName') ?? '',
      lastSyncAt: last ? Number(last) : null,
      error: s.get('error'),
      syncing: this.running !== null,
      revoked: s.get('revoked') === '1'
    }
  }

  // ---- setting up ------------------------------------------------------------------------------------

  /** Starts syncing from this device, making a new group. Returns the pairing code to show as a QR code. */
  async enable(server: string, deviceName: string): Promise<Pairing> {
    const existing = await this.pairing()
    if (existing) return existing
    const key = newDataKey()
    const groupId = newGroupId()
    const deviceId = newDeviceId()
    const keys = await newDeviceKeys()
    const url = server.replace(/\/+$/, '')
    await this.send(url, 'POST', '/v1/groups', {
      groupId,
      joinHash: await joinHash(await joinToken(key)),
      device: { id: deviceId, publicKey: keys.publicKey, name: deviceName }
    })
    await this.remember({ server: url, groupId, deviceId, deviceName, ids: 'opaque' }, key, keys.privateKey)
    return { server: url, groupId, key, ids: 'opaque' }
  }

  /** Joins a group another device made, from its pairing code. */
  async join(code: string, deviceName: string): Promise<void> {
    if (this.status().paired) throw new SyncError('This device is already syncing. Turn sync off first.')
    const p = decodePairing(code)
    if (!p) throw new SyncError('That is not a valid pairing code.')
    const deviceId = newDeviceId()
    const keys = await newDeviceKeys()
    await this.send(p.server, 'POST', '/v1/groups/join', {
      groupId: p.groupId,
      joinToken: await joinToken(p.key),
      device: { id: deviceId, publicKey: keys.publicKey, name: deviceName }
    })
    await this.remember({ server: p.server, groupId: p.groupId, deviceId, deviceName, ids: p.ids ?? 'plain' }, p.key, keys.privateKey)
  }

  private async remember(c: { server: string; groupId: string; deviceId: string; deviceName: string; ids: 'plain' | 'opaque' }, key: string, privateKey: string): Promise<void> {
    await this.d.secrets.set(KEY_SECRET, key)
    await this.d.secrets.set(PRIVATE_SECRET, privateKey)
    const s = this.d.storage
    s.clear()
    for (const [k, v] of Object.entries(c)) s.set(k, v)
    s.set('since', '0')
  }

  /** The pairing code for this group, to show again for another device. Null if this device is not syncing. */
  async pairing(): Promise<Pairing | null> {
    const s = this.d.storage
    const key = await this.d.secrets.get(KEY_SECRET)
    const groupId = s.get('groupId')
    const server = s.get('server')
    return key && groupId && server ? { server, groupId, key, ids: s.get('ids') === 'opaque' ? 'opaque' : 'plain' } : null
  }

  pairingCode(p: Pairing): string {
    return encodePairing(p)
  }

  /** Stops syncing on this device: asks the server to forget it, then forgets everything here. Settings already here stay. */
  async disable(): Promise<void> {
    const id = this.d.storage.get('deviceId')
    try {
      if (id) await this.signed('DELETE', `/v1/devices/${id}`)
    } catch {
      // The server may be unreachable or may have forgotten this device already; either way, stop here.
    }
    await this.d.secrets.delete(KEY_SECRET)
    await this.d.secrets.delete(PRIVATE_SECRET)
    this.d.storage.clear()
  }

  /**
   * Replaces the key: makes a new group with a fresh key, ends the old group on the server (so a device that was removed
   * can read nothing more, and the old copies are gone), and starts syncing into the new one. Everything on this device is
   * sent again under the new key. Other devices lose access until they join with the new code. It also moves an older group
   * onto opaque record names. Returns the new pairing code.
   */
  async rotate(): Promise<Pairing> {
    const s = this.d.storage
    const oldGroup = s.get('groupId')
    const server = s.get('server')
    const deviceName = s.get('deviceName') ?? ''
    if (!oldGroup || !server || !s.get('deviceId')) throw new SyncError('Sync is not turned on here.')
    const key = newDataKey()
    const groupId = newGroupId()
    const deviceId = newDeviceId()
    const keys = await newDeviceKeys()
    // The new group comes first, so a failure leaves the old one working.
    await this.send(server, 'POST', '/v1/groups', {
      groupId,
      joinHash: await joinHash(await joinToken(key)),
      device: { id: deviceId, publicKey: keys.publicKey, name: deviceName }
    })
    try {
      await this.signed('DELETE', '/v1/group')
    } catch (e) {
      // 401 means the old group is already gone (another device replaced the key first): nothing left to end.
      if (!(e instanceof SyncError && s.get('revoked') === '1')) throw e
    }
    await this.remember({ server, groupId, deviceId, deviceName, ids: 'opaque' }, key, keys.privateKey)
    return { server, groupId, key, ids: 'opaque' }
  }

  // ---- devices ---------------------------------------------------------------------------------------

  async devices(): Promise<SyncDevice[]> {
    const r = (await this.signed('GET', '/v1/devices')) as { devices: SyncDevice[] }
    return r.devices
  }

  async removeDevice(id: string): Promise<void> {
    await this.signed('DELETE', `/v1/devices/${id}`)
  }

  // ---- syncing ---------------------------------------------------------------------------------------

  /** One round: send what changed here, take what changed elsewhere. Rounds do not overlap. */
  syncNow(): Promise<SyncStatus> {
    if (!this.status().paired || this.status().revoked) return Promise.resolve(this.status())
    this.running ??= this.round()
      .then(() => {
        this.d.storage.remove('error')
        this.d.storage.set('lastSyncAt', String(this.now()))
      })
      .catch((e: unknown) => {
        this.d.storage.set('error', e instanceof SyncError ? e.message : 'Syncing failed. It will try again.')
      })
      .then(() => {
        this.running = null
        return this.status()
      })
    return this.running
  }

  private async round(): Promise<void> {
    const s = this.d.storage
    const key = await this.d.secrets.get(KEY_SECRET)
    const deviceId = s.get('deviceId')
    if (!key || !deviceId) throw new SyncError('Sync is not set up on this device.')
    const pending = await this.collect(key, deviceId)

    let since = Number(s.get('since') ?? '0')
    // Items that could not be stored yet are retried now and then by asking for everything again; what was
    // already applied is skipped, so this costs one longer answer.
    const now = this.now()
    if (since > 0 && Number(s.get('deferred') ?? '0') > 0 && now - Number(s.get('rewoundAt') ?? '0') >= REWIND_EVERY_MS) {
      since = 0
      s.set('rewoundAt', String(now))
    }
    // A round that asks for everything counts as the last time items were looked at again.
    if (since === 0) s.set('rewoundAt', String(now))
    this.deferred = since === 0 ? 0 : Number(s.get('deferred') ?? '0')
    let batches = chunk([...pending.keys()].map((k) => pending.get(k)!.record))
    if (batches.length === 0) batches = [[]]
    for (const records of batches) {
      since = await this.exchange(key, deviceId, since, records, pending)
      // Only now that the server has them are these changes counted as synced; a failed send is tried again next round.
      for (const r of records) this.commit(pending.get(recordKey(r))!)
    }
    // Keep asking while the server says more are waiting.
    for (let guard = 0; guard < 100; guard++) {
      const more = await this.exchange(key, deviceId, since, [], pending)
      if (more === since) break
      since = more
    }
    s.set('deferred', String(this.deferred))
  }

  /** Asks for everything again at the next round, to pick up items that were waiting for an account or message. */
  rewind(): void {
    this.d.storage.set('since', '0')
  }

  /** Compares what is here now with what was synced last, and turns the difference into records to send. */
  private async collect(key: string, deviceId: string): Promise<Map<string, Pending>> {
    const s = this.d.storage
    const out = new Map<string, Pending>()
    let last = s.get('lastHlc')
    for (const adapter of this.d.adapters) {
      let now: { id: string; data: unknown }[]
      try {
        now = adapter.list()
      } catch {
        // If this kind cannot be read right now, say nothing about it: silence must not look like a deletion.
        continue
      }
      const seen = new Set<string>()
      for (const { id, data } of now) {
        seen.add(id)
        const hash = await hashBody(stableStringify(data))
        const item = s.item(adapter.type, id)
        if (item && !item.deleted && item.hash === hash) continue
        last = tickHlc(last, this.now(), deviceId)
        const env = { id: await this.wireId(key, adapter.type, id), type: adapter.type, hlc: last, deleted: false }
        const payload = await sealPayload(key, env, this.contents(id, data))
        if (payload.length > MAX_PAYLOAD_CHARS) continue
        const record = { ...env, payload }
        out.set(recordKey(record), { record, item: { type: adapter.type, id, hash, hlc: last, deleted: false } })
      }
      for (const item of s.items(adapter.type)) {
        if (item.deleted || seen.has(item.id)) continue
        last = tickHlc(last, this.now(), deviceId)
        const env = { id: await this.wireId(key, adapter.type, item.id), type: adapter.type, hlc: last, deleted: true }
        const record = { ...env, payload: await sealPayload(key, env, this.contents(item.id, null)) }
        out.set(recordKey(record), { record, item: { type: adapter.type, id: item.id, hash: '', hlc: last, deleted: true } })
      }
    }
    return out
  }

  /** Counts a sent change as synced, unless something newer has arrived for the same item since. */
  private commit(p: Pending): void {
    const s = this.d.storage
    const cur = s.item(p.item.type, p.item.id)
    if (!cur || compareHlc(p.item.hlc, cur.hlc) > 0) s.putItem(p.item)
    const last = s.get('lastHlc')
    if (!last || compareHlc(p.item.hlc, last) > 0) s.set('lastHlc', p.item.hlc)
  }

  /** Sends records, takes everything newer than `since`, applies it, and returns the new `since`. */
  private async exchange(key: string, deviceId: string, since: number, records: SyncRecord[], pending: Map<string, Pending>): Promise<number> {
    const s = this.d.storage
    const res = syncResponse.safeParse(await this.signed('POST', '/v1/sync', { since, records }))
    if (!res.success) throw new SyncError('The sync server sent something this version does not understand.')
    await this.apply(key, deviceId, res.data.records, pending)
    s.set('since', String(res.data.seq))
    return res.data.seq
  }

  /** Applies records from other devices that are newer than what is here. */
  private async apply(key: string, deviceId: string, records: SyncRecord[], pending: Map<string, Pending>): Promise<void> {
    const s = this.d.storage
    const order = (t: SyncType) => syncTypes.indexOf(t)
    const touched = new Map<SyncType, string[]>()
    let applied = false
    const stamps = new Map<string, string>()
    for (const wire of [...records].sort((a, b) => order(a.type) - order(b.type))) {
      const adapter = this.byType.get(wire.type)
      const opened = adapter ? await this.open(key, wire) : null
      if (!adapter || !opened) continue
      // From here on the record is known by its real id; `wire` is what it was called on the server.
      const r = { ...wire, id: opened.id }
      const item = s.item(r.type, r.id)
      const mine = pending.get(recordKey(wire))
      // No newer than what is already here (this includes our own records coming back).
      if (item && compareHlc(r.hlc, item.hlc) <= 0) continue
      // A change made here that has not been sent yet and is newer than this one stands.
      if (mine && compareHlc(r.hlc, mine.record.hlc) <= 0) continue
      try {
        s.set('lastHlc', receiveHlc(s.get('lastHlc'), r.hlc, this.now(), deviceId))
      } catch {
        continue
      }
      if (r.deleted) {
        adapter.remove(r.id)
        applied = true
        s.putItem({ type: r.type, id: r.id, hash: '', hlc: r.hlc, deleted: true })
        continue
      }
      let data: unknown
      try {
        data = adapter.parse(opened.data)
      } catch {
        continue
      }
      if (data === null || data === undefined) continue
      const stored = adapter.upsert(r.id, data)
      if (stored === true) {
        applied = true
        touched.set(r.type, [...(touched.get(r.type) ?? []), r.id])
        stamps.set(recordKey(r), r.hlc)
      } else if (stored === 'later') this.deferred++
      // Nothing is recorded for an item that could not be stored: it is not sent back as a change or a deletion,
      // and a newer version of it, or a later round, can still bring it in.
    }
    if (applied) this.d.onApplied?.()
    // Record what is really stored now (an adapter may tidy what it was given), so the next round sees no change.
    for (const [type, ids] of touched) {
      const now = new Map(this.byType.get(type)!.list().map((e) => [e.id, e.data]))
      for (const id of ids) {
        const stamp = stamps.get(recordKey({ type, id }))!
        s.putItem({ type, id, hash: await hashBody(stableStringify(now.get(id) ?? null)), hlc: stamp, deleted: false })
      }
    }
  }

  // ---- talking to the server -------------------------------------------------------------------------

  /** Whether this group names records by keyed hash (new groups) or by their real id (groups made before that). */
  private opaque(): boolean {
    return this.d.storage.get('ids') === 'opaque'
  }

  /** The name a record goes by on the server. */
  private wireId(key: string, type: SyncType, id: string): Promise<string> {
    return this.opaque() ? opaqueId(key, type, id) : Promise.resolve(id)
  }

  /** What gets sealed: the data, with the real id beside it when the server is not to see it. */
  private contents(id: string, data: unknown): unknown {
    return this.opaque() ? { i: id, d: data } : data
  }

  /**
   * Opens a record that arrived and works out its real id and contents. Null when it cannot be used: damaged, sealed with
   * another key, or not named the way its real id says it should be.
   */
  private async open(key: string, r: SyncRecord): Promise<{ id: string; data: unknown } | null> {
    try {
      if (!this.opaque()) return { id: r.id, data: r.deleted ? null : await openPayload(key, r, r.payload) }
      const inner = (await openPayload(key, r, r.payload)) as { i?: unknown; d?: unknown } | null
      if (!inner || typeof inner.i !== 'string' || inner.i === '' || inner.i.length > 200) return null
      if ((await opaqueId(key, r.type, inner.i)) !== r.id) return null
      return { id: inner.i, data: r.deleted ? null : inner.d }
    } catch {
      return null
    }
  }

  private async signed(method: string, path: string, body?: unknown): Promise<unknown> {
    const s = this.d.storage
    const privateKey = await this.d.secrets.get(PRIVATE_SECRET)
    const groupId = s.get('groupId')
    const deviceId = s.get('deviceId')
    const server = s.get('server')
    if (!privateKey || !groupId || !deviceId || !server) throw new SyncError('Sync is not set up on this device.')
    const bodyText = body === undefined ? '' : JSON.stringify(body)
    const timestamp = this.now()
    const signature = await signText(privateKey, canonicalRequest({ method, path, timestamp, bodyHash: await hashBody(bodyText) }))
    return this.send(server, method, path, body, formatAuth({ groupId, deviceId, timestamp, signature }))
  }

  private async send(server: string, method: string, path: string, body?: unknown, authorization?: string): Promise<unknown> {
    let res: Response
    try {
      res = await this.fetchFn()(`${server}${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(authorization ? { Authorization: authorization } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
    } catch {
      throw new SyncError("Can't reach the sync server. Check your connection.")
    }
    const json = (await res.json().catch(() => ({}))) as { error?: string }
    if (res.ok) return json
    if (res.status === 401 && authorization) {
      this.d.storage.set('revoked', '1')
      throw new SyncError('This device was removed from sync, or its clock is far off. Turn sync on again to rejoin.')
    }
    if (res.status === 429) throw new SyncError('Too many requests. Try again in a few minutes.')
    throw new SyncError(json.error ?? `The sync server answered ${res.status}.`)
  }
}

/** Splits records into pushes small enough for the server. */
function chunk(records: SyncRecord[]): SyncRecord[][] {
  const out: SyncRecord[][] = []
  let cur: SyncRecord[] = []
  let size = 0
  for (const r of records) {
    if (cur.length >= MAX_PUSH_RECORDS || size + r.payload.length > MAX_PUSH_CHARS) {
      out.push(cur)
      cur = []
      size = 0
    }
    cur.push(r)
    size += r.payload.length
  }
  if (cur.length > 0) out.push(cur)
  return out
}
