import { timingSafeEqual } from 'node:crypto'
import type { Limiter } from './app'
import { ADMIN_PAGE } from './admin-page'
import type { Metrics } from './metrics'
import { MAX_DEVICES_PER_GROUP, MAX_RECORDS_PER_GROUP, type SyncStore } from './store'

// The admin side of the sync server: a small web page and the calls behind it. It is served on its own port that listens
// on this machine only (reach it through an SSH tunnel), and every call needs the admin token. It can see how the server
// is doing and change how it behaves, but it cannot read anyone's data: the server does not have the keys.

export interface AdminReq {
  method: string
  path: string
  authorization: string | undefined
  ip: string
  bodyText: string
}

export interface AdminRes {
  status: number
  /** JSON body, or the page itself when `html` is set. */
  json?: unknown
  html?: string
}

export interface AdminDeps {
  store: SyncStore
  metrics: Metrics
  limiter: Limiter
  now: () => number
  /** The secret that opens the dashboard. */
  token: string
  startedAt: number
  maxGroups: number
  /** Shuts the server down so the service manager starts it again. */
  restart: () => void
}

const fail = (status: number, error: string): AdminRes => ({ status, json: { error } })

const sameText = (a: string, b: string): boolean => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** An IPv4 or IPv6 address as text, and nothing else. */
const IP = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]{2,39})$/
/** Addresses this machine uses to reach itself. Banning one would lock out everyone who arrives through the proxy. */
const OWN = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'unknown'])

function body(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text) as unknown
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export async function handleAdmin(req: AdminReq, deps: AdminDeps): Promise<AdminRes> {
  const { method, path } = req
  // The page itself holds no data; it asks for the token and then calls the API.
  if (path === '/' || path === '/index.html') return method === 'GET' ? { status: 200, html: ADMIN_PAGE } : fail(405, 'Method not allowed')
  if (!path.startsWith('/api/')) return fail(404, 'Not found')

  const given = /^Bearer (.+)$/.exec(req.authorization ?? '')?.[1] ?? ''
  if (!given || !sameText(given, deps.token)) {
    // Only wrong or missing tokens count against the limit (the page itself calls often with the right one), so the
    // token cannot be guessed by trying.
    if (!deps.limiter.take('admin-try', req.ip, 20, 60_000)) return fail(429, 'Too many tries. Wait a minute.')
    deps.metrics.event('admin sign-in refused', req.ip)
    return fail(401, 'Not signed in')
  }
  const { store, metrics } = deps
  const now = deps.now()

  if (path === '/api/overview' && method === 'GET') {
    const totals = store.totals()
    return {
      status: 200,
      json: {
        now,
        startedAt: deps.startedAt,
        node: process.version,
        totals,
        signupsClosed: store.flag('signups') === 'closed',
        limits: { maxGroups: deps.maxGroups, devicesPerGroup: MAX_DEVICES_PER_GROUP, recordsPerGroup: MAX_RECORDS_PER_GROUP },
        minutes: metrics.minutes()
      }
    }
  }

  if (path === '/api/groups' && method === 'GET') return { status: 200, json: { groups: store.groupList(500) } }

  if (path === '/api/groups/prune' && method === 'POST') {
    const days = Number(body(req.bodyText)['days'])
    if (!Number.isInteger(days) || days < 1 || days > 3650) return fail(400, 'Give a number of days from 1 to 3650')
    const n = store.deleteInactive(now - days * 86_400_000)
    metrics.event('groups pruned', req.ip, `${n} unused for ${days}+ days`)
    return { status: 200, json: { removed: n } }
  }

  const group = /^\/api\/groups\/([A-Za-z0-9_-]{8,64})$/.exec(path)
  if (group && method === 'DELETE') {
    const id = group[1]!
    if (store.joinHash(id) === null) return fail(404, 'No such group')
    store.deleteGroup(id)
    metrics.event('group deleted', req.ip, id.slice(0, 8))
    return { status: 200, json: { ok: true } }
  }

  if (path === '/api/ips' && method === 'GET') return { status: 200, json: { ips: metrics.topIps(100).map((s) => ({ ...s, banned: store.isBanned(s.ip) })) } }
  if (path === '/api/events' && method === 'GET') return { status: 200, json: { events: metrics.events(150) } }
  if (path === '/api/bans' && method === 'GET') return { status: 200, json: { bans: store.bans() } }

  if (path === '/api/bans' && method === 'POST') {
    const b = body(req.bodyText)
    const ip = typeof b['ip'] === 'string' ? b['ip'].trim() : ''
    if (!IP.test(ip)) return fail(400, 'That is not an IP address')
    if (OWN.has(ip)) return fail(400, 'That is this server itself. Banning it would block everyone.')
    store.addBan(ip, typeof b['reason'] === 'string' ? b['reason'] : '', now)
    metrics.event('address banned', req.ip, ip)
    return { status: 200, json: { ok: true } }
  }

  const ban = /^\/api\/bans\/([0-9a-fA-F:.]{2,45})$/.exec(path)
  if (ban && method === 'DELETE') {
    const ip = decodeURIComponent(ban[1]!)
    if (!store.removeBan(ip)) return fail(404, 'That address is not banned')
    metrics.event('address unbanned', req.ip, ip)
    return { status: 200, json: { ok: true } }
  }

  if (path === '/api/signups' && method === 'POST') {
    const closed = body(req.bodyText)['closed'] === true
    store.setFlag('signups', closed ? 'closed' : null)
    metrics.event(closed ? 'signups closed' : 'signups opened', req.ip)
    return { status: 200, json: { signupsClosed: closed } }
  }

  if (path === '/api/restart' && method === 'POST') {
    metrics.event('restart requested', req.ip)
    // Answer first; the server goes down a moment later.
    setTimeout(deps.restart, 300).unref?.()
    return { status: 200, json: { ok: true } }
  }

  return fail(404, 'Not found')
}
