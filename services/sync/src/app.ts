import { timingSafeEqual } from 'node:crypto'
import {
  canonicalRequest,
  createGroupRequest,
  hashBody,
  isPlausibleHlc,
  joinGroupRequest,
  joinHash,
  MAX_REQUEST_SKEW_MS,
  parseAuth,
  syncRequest,
  verifyText,
  type SyncResponse
} from '@imc/core'
import type { Metrics } from './metrics'
import { MAX_DEVICES_PER_GROUP, type DeviceRow, type SyncStore } from './store'

// The logic of the sync server, apart from the HTTP wrapper so it can be tested directly.
//
// Anyone on the internet can reach it, so every route checks and limits what it is given. Devices prove
// who they are by signing each request with a key the server was given when they joined. The server
// stores encrypted records and cannot read them.

export interface Req {
  method: string
  path: string
  /** The Authorization header, if any. */
  authorization: string | undefined
  ip: string
  bodyText: string
}

export interface Res {
  status: number
  json: unknown
}

/** A sliding-window limiter: at most `max` hits per key within `windowMs`. */
export class Limiter {
  private hits = new Map<string, number[]>()

  constructor(private now: () => number = Date.now) {}

  take(bucket: string, key: string, max: number, windowMs: number): boolean {
    const t = this.now()
    const k = `${bucket}:${key}`
    const list = (this.hits.get(k) ?? []).filter((x) => t - x < windowMs)
    if (list.length >= max) {
      this.hits.set(k, list)
      return false
    }
    list.push(t)
    this.hits.set(k, list)
    // Forget keys that have gone quiet, so the map cannot grow without end.
    if (this.hits.size > 20_000) for (const [name, v] of this.hits) if (!v.some((x) => t - x < 3_600_000)) this.hits.delete(name)
    return true
  }
}

export interface Deps {
  store: SyncStore
  limiter: Limiter
  now: () => number
  /** Most groups the server will hold. */
  maxGroups?: number
  /** Traffic counts for the admin dashboard. */
  metrics?: Metrics
}

const fail = (status: number, error: string): Res => ({ status, json: { error } })
const HOUR = 3_600_000

const publicDevice = (d: DeviceRow, current: string) => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeen: d.lastSeen, current: d.id === current })

function parseJson(text: string): unknown {
  try {
    return text === '' ? undefined : JSON.parse(text)
  } catch {
    return undefined
  }
}

const sameText = (a: string, b: string): boolean => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

interface Authed {
  groupId: string
  device: DeviceRow
}

/** Checks the signature on a request. A device that is unknown, revoked or signs the wrong thing all look the same. */
async function authenticate(req: Req, deps: Deps): Promise<Authed | Res> {
  const auth = parseAuth(req.authorization)
  if (!auth) return fail(401, 'Not signed in')
  const t = deps.now()
  if (Math.abs(t - auth.timestamp) > MAX_REQUEST_SKEW_MS) return fail(401, 'The clock on this device is off by too much')
  const device = deps.store.device(auth.groupId, auth.deviceId)
  const text = canonicalRequest({ method: req.method, path: req.path, timestamp: auth.timestamp, bodyHash: await hashBody(req.bodyText) })
  if (!device || !(await verifyText(device.publicKey, text, auth.signature))) return fail(401, 'Not signed in')
  if (!deps.limiter.take('device', `${auth.groupId}:${auth.deviceId}`, 120, 60_000)) return fail(429, 'Too many requests')
  deps.store.touch(auth.groupId, auth.deviceId, t)
  return { groupId: auth.groupId, device }
}

/** Answers one request: banned addresses are turned away first, and every answer is counted for the dashboard. */
export async function handle(req: Req, deps: Deps): Promise<Res> {
  if (req.path !== '/healthz' && deps.store.isBanned(req.ip)) {
    deps.metrics?.hit(req.ip, 403, true)
    return fail(403, 'Not allowed')
  }
  const res = await route(req, deps)
  deps.metrics?.hit(req.ip, res.status)
  return res
}

async function route(req: Req, deps: Deps): Promise<Res> {
  const { method, path } = req
  if (path === '/healthz') return method === 'GET' ? { status: 200, json: { ok: true } } : fail(405, 'Method not allowed')

  if (path === '/v1/groups') {
    if (method !== 'POST') return fail(405, 'Method not allowed')
    const body = createGroupRequest.safeParse(parseJson(req.bodyText))
    if (!body.success) return fail(400, 'Not a valid request')
    if (!deps.limiter.take('create', req.ip, 5, HOUR)) return fail(429, 'Too many requests')
    if (deps.store.flag('signups') === 'closed' || deps.store.groupCount() >= (deps.maxGroups ?? 5000)) return fail(503, 'This server is not taking new groups')
    const { groupId, joinHash: hash, device } = body.data
    const made = deps.store.createGroup(groupId, hash, { id: device.id, publicKey: device.publicKey, name: device.name }, deps.now())
    if (made) deps.metrics?.event('group created', req.ip)
    return made ? { status: 201, json: { ok: true } } : fail(409, 'That group already exists')
  }

  if (path === '/v1/groups/join') {
    if (method !== 'POST') return fail(405, 'Method not allowed')
    const body = joinGroupRequest.safeParse(parseJson(req.bodyText))
    if (!body.success) return fail(400, 'Not a valid request')
    if (!deps.limiter.take('join', req.ip, 20, HOUR)) return fail(429, 'Too many requests')
    const { groupId, joinToken, device } = body.data
    const stored = deps.store.joinHash(groupId)
    // A group that does not exist and a wrong token get the same answer, so ids cannot be probed.
    if (stored === null || !sameText(stored, await joinHash(joinToken))) return fail(403, 'Not allowed')
    const added = deps.store.addDevice(groupId, { id: device.id, publicKey: device.publicKey, name: device.name }, deps.now())
    if (added === 'full') return fail(409, `A group can have ${MAX_DEVICES_PER_GROUP} devices; remove one first`)
    if (added === 'taken') return fail(409, 'That device id is already in use')
    deps.metrics?.event('device joined', req.ip)
    return { status: 200, json: { ok: true } }
  }

  const known = path === '/v1/sync' || path === '/v1/group' || path === '/v1/devices' || /^\/v1\/devices\/[A-Za-z0-9_]{4,32}$/.test(path)
  if (!known) return fail(404, 'Not found')

  const who = await authenticate(req, deps)
  if ('status' in who) return who
  const now = deps.now()

  if (path === '/v1/sync') {
    if (method !== 'POST') return fail(405, 'Method not allowed')
    const body = syncRequest.safeParse(parseJson(req.bodyText))
    if (!body.success) return fail(400, 'Not a valid request')
    const { since, records, limit } = body.data
    // A record stamped far in the future would beat every later edit, so it is not accepted.
    const sane = records.filter((r) => isPlausibleHlc(r.hlc, now))
    const pushed = deps.store.push(who.groupId, sane)
    const page = deps.store.pull(who.groupId, since, limit)
    const out: SyncResponse = { ...page, refused: records.length - sane.length + pushed.refused }
    return { status: 200, json: out }
  }

  // DELETE /v1/group ends the whole group: its devices and everything stored for them. Used when the key is replaced.
  if (path === '/v1/group') {
    if (method !== 'DELETE') return fail(405, 'Method not allowed')
    deps.store.deleteGroup(who.groupId)
    return { status: 200, json: { ok: true } }
  }

  if (path === '/v1/devices') {
    if (method !== 'GET') return fail(405, 'Method not allowed')
    return { status: 200, json: { devices: deps.store.devices(who.groupId).map((d) => publicDevice(d, who.device.id)) } }
  }

  // DELETE /v1/devices/:id removes a device, which may be this one.
  if (method !== 'DELETE') return fail(405, 'Method not allowed')
  const id = path.slice('/v1/devices/'.length)
  return deps.store.removeDevice(who.groupId, id) ? { status: 200, json: { ok: true } } : fail(404, 'No such device')
}
