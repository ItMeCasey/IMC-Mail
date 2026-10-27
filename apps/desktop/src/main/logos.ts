import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Company logos for the message list. The window is not allowed to load pictures from the web (its security policy
// only allows its own files and inline data), so the logo for a sender's domain is fetched here, kept on disk, and
// handed to the window as a small inline picture. Domains that have no logo are remembered for a few days so they are
// not asked for again every time the list opens.

const LOGO_KEEP_MS = 30 * 86_400_000
const MISS_KEEP_MS = 3 * 86_400_000
const MAX_BYTES = 80_000
const MAX_AT_ONCE = 6
const TYPES = new Set(['image/png', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/jpeg', 'image/webp', 'image/gif'])
const DOMAIN = /^(?=.{3,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

export interface LogoDeps {
  /** A folder to keep the pictures in. */
  dir: string
  fetchFn: typeof fetch
  now?: () => number
}

/** Where a domain's icon comes from. The service answers "not found" when it has none. */
export const logoUrl = (domain: string): string => `https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://${domain}&size=64`

export function createLogos(deps: LogoDeps) {
  const now = () => (deps.now ?? Date.now)()
  const inflight = new Map<string, Promise<string | null>>()
  const memory = new Map<string, { value: string | null; at: number }>()
  let running = 0
  const waiting: (() => void)[] = []

  const slot = async <T>(job: () => Promise<T>): Promise<T> => {
    while (running >= MAX_AT_ONCE) await new Promise<void>((r) => waiting.push(r))
    running++
    try {
      return await job()
    } finally {
      running--
      waiting.shift()?.()
    }
  }

  const file = (domain: string, ext: 'img' | 'none') => join(deps.dir, `${domain}.${ext}`)

  function fromDisk(domain: string): { value: string | null } | null {
    const t = now()
    try {
      const img = file(domain, 'img')
      if (existsSync(img) && t - statSync(img).mtimeMs < LOGO_KEEP_MS) return { value: readFileSync(img, 'utf8') }
      const none = file(domain, 'none')
      if (existsSync(none) && t - statSync(none).mtimeMs < MISS_KEEP_MS) return { value: null }
    } catch {
      // An unreadable cache is the same as an empty one.
    }
    return null
  }

  function remember(domain: string, value: string | null): void {
    memory.set(domain, { value, at: now() })
    try {
      mkdirSync(deps.dir, { recursive: true })
      if (value) writeFileSync(file(domain, 'img'), value)
      else {
        writeFileSync(file(domain, 'none'), '')
        utimesSync(file(domain, 'none'), new Date(now()), new Date(now()))
      }
    } catch {
      // The logo still shows this time; it will be fetched again next time.
    }
  }

  async function download(domain: string): Promise<string | null> {
    try {
      const res = await deps.fetchFn(logoUrl(domain), { redirect: 'follow', signal: AbortSignal.timeout(8000) })
      if (!res.ok) return null
      const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
      if (!TYPES.has(type)) return null
      const bytes = Buffer.from(await res.arrayBuffer())
      if (bytes.length === 0 || bytes.length > MAX_BYTES) return null
      return `data:${type};base64,${bytes.toString('base64')}`
    } catch {
      return null
    }
  }

  function one(domain: string): Promise<string | null> {
    const hot = memory.get(domain)
    if (hot && now() - hot.at < MISS_KEEP_MS) return Promise.resolve(hot.value)
    const saved = fromDisk(domain)
    if (saved) {
      memory.set(domain, { value: saved.value, at: now() })
      return Promise.resolve(saved.value)
    }
    let p = inflight.get(domain)
    if (!p) {
      p = slot(() => download(domain)).then((value) => {
        remember(domain, value)
        inflight.delete(domain)
        return value
      })
      inflight.set(domain, p)
    }
    return p
  }

  return {
    /** The logo of each domain as an inline picture, or null where there is none. Anything that is not a plain domain name is ignored. */
    async get(domains: string[]): Promise<Record<string, string | null>> {
      const wanted = [...new Set(domains.map((d) => d.toLowerCase()))].filter((d) => DOMAIN.test(d)).slice(0, 80)
      const out: Record<string, string | null> = {}
      await Promise.all(wanted.map(async (d) => void (out[d] = await one(d))))
      return out
    }
  }
}
