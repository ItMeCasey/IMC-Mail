// IMC-Mail sync server. One file once built (see vite.config.ts); needs Node 22.13 or newer.
// Settings come from environment variables:
//   PORT          default 8788 (listens on 127.0.0.1; put nginx in front of it)
//   DB_PATH       default ./sync.sqlite
//   TRUST_PROXY   set to 1 when behind nginx, so the caller's address is read from X-Forwarded-For
//   MAX_GROUPS    default 5000
//   ADMIN_TOKEN   at least 24 characters. Turns on the admin dashboard, served on ADMIN_PORT (default 8789) on this machine only;
//                 reach it through an SSH tunnel. Without a token there is no dashboard.
import { createServer } from 'node:http'
import { handleAdmin, type AdminRes } from './admin'
import { Limiter, handle } from './app'
import { Metrics } from './metrics'
import { SyncStore } from './store'

/** The caller's address behind a proxy: nginx adds what it saw to the end of X-Forwarded-For, so the last entry is the one a caller cannot choose. */
const clientIp = (forwardedFor: string | undefined, socket: string | undefined): string => (forwardedFor ?? '').split(',').pop()!.trim() || socket || 'unknown'

const MAX_BODY_BYTES = 4_000_000
const port = Number(process.env['PORT'] ?? 8788)
const trustProxy = process.env['TRUST_PROXY'] === '1'
const store = new SyncStore(process.env['DB_PATH'] ?? './sync.sqlite')
const startedAt = Date.now()
const metrics = new Metrics()
const limiter = new Limiter()
const maxGroups = Number(process.env['MAX_GROUPS'] ?? 5000)
const deps = { store, limiter, now: Date.now, maxGroups, metrics }

const server = createServer((req, res) => {
  const chunks: Buffer[] = []
  let size = 0
  req.on('data', (c: Buffer) => {
    size += c.length
    if (size > MAX_BODY_BYTES) {
      res.writeHead(413).end()
      req.destroy()
      return
    }
    chunks.push(c)
  })
  req.on('end', () => {
    const header = req.headers['x-forwarded-for']
    const ip = trustProxy ? clientIp(Array.isArray(header) ? header.join(',') : header, req.socket.remoteAddress) : req.socket.remoteAddress || 'unknown'
    handle(
      {
        method: req.method ?? 'GET',
        path: (req.url ?? '/').split('?')[0]!,
        authorization: req.headers.authorization,
        ip,
        bodyText: Buffer.concat(chunks).toString('utf8')
      },
      deps
    )
      .catch((e: unknown) => {
        console.error('[sync] request failed', e)
        return { status: 500, json: { error: 'Something went wrong' } }
      })
      .then((out) => {
        res.writeHead(out.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(out.json))
      })
  })
  req.on('error', () => res.destroy())
})
server.requestTimeout = 20_000
server.listen(port, '127.0.0.1', () => console.log(`sync server listening on 127.0.0.1:${port}`))

// ---- the admin dashboard ----------------------------------------------------------------------------------

/** Closes the sign-in and exits with an error code, so the service manager (Restart=on-failure) starts the server again. */
const restart = (): void => {
  server.close(() => {
    store.close()
    process.exit(1)
  })
  setTimeout(() => process.exit(1), 3000).unref()
}

const adminToken = process.env['ADMIN_TOKEN'] ?? ''
if (adminToken.length >= 24) {
  const adminPort = Number(process.env['ADMIN_PORT'] ?? 8789)
  const admin = createServer((req, res) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > 100_000) {
        res.writeHead(413).end()
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      handleAdmin(
        {
          method: req.method ?? 'GET',
          path: (req.url ?? '/').split('?')[0]!,
          authorization: req.headers.authorization,
          ip: req.socket.remoteAddress ?? 'unknown',
          bodyText: Buffer.concat(chunks).toString('utf8')
        },
        { store, metrics, limiter, now: Date.now, token: adminToken, startedAt, maxGroups, restart }
      )
        .catch((e: unknown): AdminRes => {
          console.error('[sync] admin request failed', e)
          return { status: 500, json: { error: 'Something went wrong' } }
        })
        .then((out) => {
          if (out.html !== undefined) {
            res.writeHead(out.status, {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
              'X-Frame-Options': 'DENY',
              'Referrer-Policy': 'no-referrer',
              'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
            })
            res.end(out.html)
          } else {
            res.writeHead(out.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
            res.end(JSON.stringify(out.json))
          }
        })
    })
    req.on('error', () => res.destroy())
  })
  admin.requestTimeout = 20_000
  // Only this machine can reach it: nobody on the internet, and the sync address does not forward to it.
  admin.listen(adminPort, '127.0.0.1', () => console.log(`[sync] admin dashboard on 127.0.0.1:${adminPort}`))
} else if (adminToken !== '') {
  console.error('[sync] ADMIN_TOKEN is too short (24 characters at least); the admin dashboard is off')
}

// Deletion records are kept for six months so a device that syncs now and then still hears about them, then dropped.
const KEEP_DELETED_MS = 180 * 24 * 60 * 60 * 1000
const prune = () => {
  try {
    const n = store.pruneDeleted(Date.now(), KEEP_DELETED_MS)
    if (n > 0) console.log(`[sync] dropped ${n} old deletion records`)
  } catch (e) {
    console.error('[sync] pruning failed', e)
  }
}
prune()
setInterval(prune, 6 * 60 * 60 * 1000).unref()

const stop = () => {
  server.close(() => {
    store.close()
    process.exit(0)
  })
  setTimeout(() => process.exit(0), 5000).unref()
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
