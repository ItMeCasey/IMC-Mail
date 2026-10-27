// IMC-Mail sync server. One file once built (see vite.config.ts); needs Node 22.13 or newer.
// Settings come from environment variables:
//   PORT          default 8788 (listens on 127.0.0.1; put nginx in front of it)
//   DB_PATH       default ./sync.sqlite
//   TRUST_PROXY   set to 1 when behind nginx, so the caller's address is read from X-Forwarded-For
//   MAX_GROUPS    default 5000
import { createServer } from 'node:http'
import { Limiter, handle } from './app'
import { SyncStore } from './store'

/** The caller's address behind a proxy: nginx adds what it saw to the end of X-Forwarded-For, so the last entry is the one a caller cannot choose. */
const clientIp = (forwardedFor: string | undefined, socket: string | undefined): string => (forwardedFor ?? '').split(',').pop()!.trim() || socket || 'unknown'

const MAX_BODY_BYTES = 4_000_000
const port = Number(process.env['PORT'] ?? 8788)
const trustProxy = process.env['TRUST_PROXY'] === '1'
const store = new SyncStore(process.env['DB_PATH'] ?? './sync.sqlite')
const deps = { store, limiter: new Limiter(), now: Date.now, maxGroups: Number(process.env['MAX_GROUPS'] ?? 5000) }

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

const stop = () => {
  server.close(() => {
    store.close()
    process.exit(0)
  })
  setTimeout(() => process.exit(0), 5000).unref()
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
