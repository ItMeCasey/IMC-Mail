// Problem-report relay: receives a report from IMC-Mail and files it as a GitHub issue.
// Zero dependencies; needs Node 20 or newer. Settings come from environment variables:
//   GITHUB_TOKEN   fine-grained token for ONE repository with "Issues: Read and write" only
//   GITHUB_REPO    owner/name, default ItMeCasey/IMC-Mail
//   PORT           default 8787 (listens on 127.0.0.1; put nginx in front of it)
//   TRUST_PROXY    set to 1 when behind nginx, so the caller's address is read from X-Forwarded-For
import { createServer } from 'node:http'
import { clientIp, githubClient, handle, Limiter } from './relay.mjs'

const token = process.env.GITHUB_TOKEN
if (!token) {
  console.error('GITHUB_TOKEN is not set.')
  process.exit(1)
}
const repo = process.env.GITHUB_REPO ?? 'ItMeCasey/IMC-Mail'
const port = Number(process.env.PORT ?? 8787)
const trustProxy = process.env.TRUST_PROXY === '1'
const limiter = new Limiter()
const github = githubClient(token)

const server = createServer((req, res) => {
  const chunks = []
  let size = 0
  req.on('data', (c) => {
    size += c.length
    if (size > 30_000) {
      res.writeHead(413).end()
      req.destroy()
      return
    }
    chunks.push(c)
  })
  req.on('end', async () => {
    const ip = trustProxy ? clientIp(req.headers['x-forwarded-for'], req.socket.remoteAddress) : req.socket.remoteAddress || 'unknown'
    const path = (req.url ?? '/').split('?')[0]
    const out = await handle({ method: req.method, path, ip, bodyText: Buffer.concat(chunks).toString('utf8') }, { limiter, github, repo })
    res.writeHead(out.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(out.json))
  })
  req.on('error', () => res.destroy())
})
server.requestTimeout = 15_000
server.listen(port, '127.0.0.1', () => console.log(`report relay listening on 127.0.0.1:${port} for ${repo}`))
