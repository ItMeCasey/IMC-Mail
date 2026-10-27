import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { newDataKey, newDeviceKeys, newGroupId, newDeviceId, joinHash, joinToken } from '@imc/core'
import { handleAdmin, type AdminDeps, type AdminReq } from './admin'
import { ADMIN_PAGE } from './admin-page'
import { handle, Limiter, type Deps } from './app'
import { Metrics } from './metrics'
import { SyncStore } from './store'

const TOKEN = 'a-long-enough-admin-token-for-tests'
let clock: { t: number }
let store: SyncStore
let metrics: Metrics
let restarted: number
let admin: AdminDeps
let app: Deps

beforeEach(() => {
  clock = { t: Date.UTC(2026, 9, 27, 12, 0, 0) }
  store = new SyncStore(':memory:')
  metrics = new Metrics(() => clock.t)
  restarted = 0
  const limiter = new Limiter(() => clock.t)
  admin = { store, metrics, limiter, now: () => clock.t, token: TOKEN, startedAt: clock.t - 60_000, maxGroups: 5000, restart: () => void restarted++ }
  app = { store, limiter, now: () => clock.t, metrics }
})

const call = (method: string, path: string, body?: unknown, token: string | null = TOKEN, ip = '127.0.0.1'): Promise<ReturnType<typeof handleAdmin> extends Promise<infer R> ? R : never> =>
  handleAdmin({ method, path, authorization: token === null ? undefined : `Bearer ${token}`, ip, bodyText: body === undefined ? '' : JSON.stringify(body) } as AdminReq, admin)

/** Makes a group the way a device does, through the real request handler. */
async function makeGroup(ip = '9.9.9.9') {
  const keys = await newDeviceKeys()
  const groupId = newGroupId()
  const res = await handle(
    { method: 'POST', path: '/v1/groups', authorization: undefined, ip, bodyText: JSON.stringify({ groupId, joinHash: await joinHash(await joinToken(newDataKey())), device: { id: newDeviceId(), publicKey: keys.publicKey, name: 'Test' } }) },
    app
  )
  return { groupId, status: res.status }
}

describe('signing in', () => {
  it('serves the page without a token, and everything else only with one', async () => {
    const page = await call('GET', '/', undefined, null)
    expect(page.status).toBe(200)
    expect(page.html).toBe(ADMIN_PAGE)
    expect((await call('GET', '/api/overview', undefined, null)).status).toBe(401)
    expect((await call('GET', '/api/overview', undefined, 'not-the-token')).status).toBe(401)
    expect((await call('GET', '/api/overview')).status).toBe(200)
  })

  it('slows down someone trying many tokens', async () => {
    for (let i = 0; i < 20; i++) await call('GET', '/api/overview', undefined, `wrong-${i}`, '5.5.5.5')
    expect((await call('GET', '/api/overview', undefined, TOKEN, '5.5.5.5')).status).toBe(429)
    // Someone else is not affected.
    expect((await call('GET', '/api/overview', undefined, TOKEN, '6.6.6.6')).status).toBe(200)
  })

  it('leaves out of the page anything that could run text from the server as script', () => {
    expect(ADMIN_PAGE).not.toContain('innerHTML')
    expect(ADMIN_PAGE).not.toContain('eval(')
  })
})

describe('the overview', () => {
  it('counts groups, devices and records, and the traffic of the last hour', async () => {
    await makeGroup()
    const o = (await call('GET', '/api/overview')).json as { totals: { groups: number; devices: number }; minutes: { requests: number }[]; signupsClosed: boolean; startedAt: number; now: number }
    expect(o.totals).toMatchObject({ groups: 1, devices: 1 })
    expect(o.minutes).toHaveLength(60)
    expect(o.minutes.reduce((n, m) => n + m.requests, 0)).toBe(1)
    expect(o.signupsClosed).toBe(false)
    expect(o.now - o.startedAt).toBe(60_000)
  })

  it('lists groups with their devices and when they were last used', async () => {
    const a = await makeGroup()
    clock.t += 3_600_000
    await makeGroup()
    const list = ((await call('GET', '/api/groups')).json as { groups: { id: string; devices: number; records: number }[] }).groups
    expect(list).toHaveLength(2)
    expect(list.find((g) => g.id === a.groupId)).toMatchObject({ devices: 1, records: 0 })
  })
})

describe('banning addresses', () => {
  it('refuses a banned address everywhere but the health check, and lets it back in when unbanned', async () => {
    expect((await call('POST', '/api/bans', { ip: '1.2.3.4', reason: 'hammering' })).status).toBe(200)
    expect((await makeGroup('1.2.3.4')).status).toBe(403)
    expect((await handle({ method: 'GET', path: '/healthz', authorization: undefined, ip: '1.2.3.4', bodyText: '' }, app)).status).toBe(200)
    expect((await makeGroup('8.8.8.8')).status).toBe(201)

    const bans = ((await call('GET', '/api/bans')).json as { bans: { ip: string; reason: string }[] }).bans
    expect(bans).toMatchObject([{ ip: '1.2.3.4', reason: 'hammering' }])
    expect((await call('DELETE', '/api/bans/1.2.3.4')).status).toBe(200)
    expect((await makeGroup('1.2.3.4')).status).toBe(201)
    expect((await call('DELETE', '/api/bans/1.2.3.4')).status).toBe(404)
  })

  it('keeps bans across a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'imc-ban-'))
    try {
      const file = join(dir, 'sync.sqlite')
      const a = new SyncStore(file)
      a.addBan('7.7.7.7', 'x', 1)
      a.close()
      const b = new SyncStore(file)
      expect(b.isBanned('7.7.7.7')).toBe(true)
      b.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('will not ban this server itself, and rejects things that are not addresses', async () => {
    expect((await call('POST', '/api/bans', { ip: '127.0.0.1' })).status).toBe(400)
    expect((await call('POST', '/api/bans', { ip: '::1' })).status).toBe(400)
    expect((await call('POST', '/api/bans', { ip: 'not an ip' })).status).toBe(400)
    expect((await call('POST', '/api/bans', { ip: '1.2.3.4; DROP TABLE ban' })).status).toBe(400)
    expect((await call('POST', '/api/bans', {})).status).toBe(400)
  })

  it('shows the busiest addresses and whether each is banned', async () => {
    await makeGroup('2.2.2.2')
    await call('POST', '/api/bans', { ip: '2.2.2.2' })
    const ips = ((await call('GET', '/api/ips')).json as { ips: { ip: string; banned: boolean }[] }).ips
    expect(ips.find((i) => i.ip === '2.2.2.2')).toMatchObject({ banned: true })
  })
})

describe('closing signups', () => {
  it('turns away new groups while closed, and lets devices of existing groups carry on', async () => {
    expect((await call('POST', '/api/signups', { closed: true })).status).toBe(200)
    expect((await makeGroup()).status).toBe(503)
    expect((await call('GET', '/api/overview')).json).toMatchObject({ signupsClosed: true })
    await call('POST', '/api/signups', { closed: false })
    expect((await makeGroup()).status).toBe(201)
  })
})

describe('removing groups', () => {
  it('deletes one group and says so when it is not there', async () => {
    const g = await makeGroup()
    expect((await call('DELETE', `/api/groups/${g.groupId}`)).status).toBe(200)
    expect(store.groupCount()).toBe(0)
    expect((await call('DELETE', `/api/groups/${g.groupId}`)).status).toBe(404)
  })

  it('deletes groups nobody has used for a number of days, and keeps the rest', async () => {
    await makeGroup()
    clock.t += 100 * 86_400_000
    const fresh = await makeGroup()
    const r = (await call('POST', '/api/groups/prune', { days: 90 })).json as { removed: number }
    expect(r.removed).toBe(1)
    expect(store.groupCount()).toBe(1)
    expect(store.joinHash(fresh.groupId)).not.toBeNull()
    expect((await call('POST', '/api/groups/prune', { days: 0 })).status).toBe(400)
  })
})

describe('events and restarting', () => {
  it('records what happened, newest first', async () => {
    await makeGroup('3.3.3.3')
    await call('POST', '/api/bans', { ip: '4.4.4.4' })
    const kinds = ((await call('GET', '/api/events')).json as { events: { kind: string }[] }).events.map((e) => e.kind)
    expect(kinds[0]).toBe('address banned')
    expect(kinds).toContain('group created')
  })

  it('asks for a restart, after answering', async () => {
    vi.useFakeTimers()
    try {
      expect((await call('POST', '/api/restart')).status).toBe(200)
      expect(restarted).toBe(0)
      vi.advanceTimersByTime(400)
      expect(restarted).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers not found and wrong-method cleanly', async () => {
    expect((await call('GET', '/nope')).status).toBe(404)
    expect((await call('GET', '/api/nope')).status).toBe(404)
    expect((await call('POST', '/')).status).toBe(405)
  })
})
