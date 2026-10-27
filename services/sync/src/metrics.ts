// What the admin dashboard shows about traffic. Everything here lives in memory and starts fresh when the server
// restarts; nothing about what devices send (which the server cannot read anyway) is kept, only counts and addresses.

export interface MinuteBucket {
  /** Start of the minute, epoch ms. */
  at: number
  requests: number
  /** Server errors (5xx). */
  errors: number
  /** Requests turned away for going too fast (429). */
  limited: number
  /** Requests that were not signed in (401). */
  unauthorized: number
  /** Requests from a banned address. */
  banned: number
}

export interface IpStat {
  ip: string
  requests: number
  /** 401, 403 and 429 answers: a sign of someone guessing or hammering. */
  refused: number
  lastSeen: number
}

export interface ServerEvent {
  at: number
  kind: string
  ip: string
  detail: string
}

const MINUTE = 60_000
const KEEP_MINUTES = 60
const MAX_IPS = 2_000
const MAX_EVENTS = 300

export class Metrics {
  private buckets: MinuteBucket[] = []
  private ips = new Map<string, IpStat>()
  private log: ServerEvent[] = []
  /** Rate-limit events are noisy; note each address once a minute. */
  private limitedAt = new Map<string, number>()

  constructor(private now: () => number = Date.now) {}

  private bucket(): MinuteBucket {
    const at = Math.floor(this.now() / MINUTE) * MINUTE
    const last = this.buckets[this.buckets.length - 1]
    if (last && last.at === at) return last
    const fresh: MinuteBucket = { at, requests: 0, errors: 0, limited: 0, unauthorized: 0, banned: 0 }
    this.buckets.push(fresh)
    while (this.buckets.length > KEEP_MINUTES) this.buckets.shift()
    return fresh
  }

  /** Counts one answered request. */
  hit(ip: string, status: number, banned = false): void {
    const b = this.bucket()
    b.requests++
    if (banned) b.banned++
    else if (status >= 500) b.errors++
    else if (status === 429) b.limited++
    else if (status === 401) b.unauthorized++

    const t = this.now()
    let s = this.ips.get(ip)
    if (!s) {
      if (this.ips.size >= MAX_IPS) {
        // Make room by dropping the address that has been quiet longest.
        let oldest: IpStat | null = null
        for (const v of this.ips.values()) if (!oldest || v.lastSeen < oldest.lastSeen) oldest = v
        if (oldest) this.ips.delete(oldest.ip)
      }
      s = { ip, requests: 0, refused: 0, lastSeen: t }
      this.ips.set(ip, s)
    }
    s.requests++
    s.lastSeen = t
    if (banned || status === 401 || status === 403 || status === 429) s.refused++
    if (status === 429 && t - (this.limitedAt.get(ip) ?? 0) > MINUTE) {
      this.limitedAt.set(ip, t)
      this.event('rate limited', ip)
    }
    if (this.limitedAt.size > 5_000) this.limitedAt.clear()
  }

  event(kind: string, ip: string, detail = ''): void {
    this.log.push({ at: this.now(), kind, ip, detail })
    while (this.log.length > MAX_EVENTS) this.log.shift()
  }

  /** The last hour as minutes, oldest first, with the quiet minutes filled in as zeros. */
  minutes(): MinuteBucket[] {
    const end = Math.floor(this.now() / MINUTE) * MINUTE
    const have = new Map(this.buckets.map((b) => [b.at, b]))
    return Array.from({ length: KEEP_MINUTES }, (_, i) => {
      const at = end - (KEEP_MINUTES - 1 - i) * MINUTE
      return have.get(at) ?? { at, requests: 0, errors: 0, limited: 0, unauthorized: 0, banned: 0 }
    })
  }

  /** The busiest addresses, most requests first. */
  topIps(limit = 50): IpStat[] {
    return [...this.ips.values()].sort((a, b) => b.requests - a.requests).slice(0, limit)
  }

  /** The newest events first. */
  events(limit = 100): ServerEvent[] {
    return this.log.slice(-limit).reverse()
  }
}
