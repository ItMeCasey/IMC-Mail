import type { Connect, MailSocket, Security } from './socket'
import type { MailCache, SyncResult } from './mailbox'
import type { Summary } from './imap'
import { parseSummary } from './summary'

// POP3: the old, simple way to read mail. A server has one inbox and no folders or read marks, and numbers its
// messages afresh each session, so each message is known by its UIDL (a stable id). This client lists, downloads
// and deletes; `syncPop3` keeps a local copy in the same shape as an IMAP folder.

export interface Pop3Options {
  host: string
  port: number
  security: Security
  timeoutMs?: number
}

export class Pop3Error extends Error {
  constructor(
    message: string,
    readonly kind: 'refused' | 'auth' | 'closed' | 'timeout' | 'protocol'
  ) {
    super(message)
  }
}

const enc = new TextEncoder()
const latin1 = (b: Uint8Array): string => {
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return s
}

interface Waiter {
  multi: boolean
  resolve: (r: { ok: boolean; text: string; body: Uint8Array | null }) => void
  reject: (e: Error) => void
}

export class Pop3Client {
  private socket: MailSocket | null = null
  private buf = new Uint8Array(0)
  private waiter: Waiter | null = null
  private status: { ok: boolean; text: string } | null = null
  private lines: Uint8Array[] = []
  private closed: Error | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private early: { ok: boolean; text: string } | null = null
  private greeted = false
  private caps = new Set<string>()

  constructor(
    private connect: Connect,
    private o: Pop3Options
  ) {}

  async open(): Promise<void> {
    const socket = await this.connect(this.o.host, this.o.port, this.o.security === 'tls')
    this.socket = socket
    socket.onData((chunk) => {
      const next = new Uint8Array(this.buf.length + chunk.length)
      next.set(this.buf)
      next.set(chunk, this.buf.length)
      this.buf = next
      this.drain()
    })
    socket.onClose((e) => this.end(e ?? new Pop3Error('The connection closed', 'closed')))
    const hello = await this.greeting()
    if (!hello.ok) throw new Pop3Error(`The server refused the connection: ${hello.text}`, 'refused')
    if (this.o.security === 'starttls') {
      await this.getCaps()
      if (!this.caps.has('STLS')) throw new Pop3Error('The server does not offer STLS, so the connection would not be private', 'protocol')
      await this.cmd('STLS')
      await socket.startTls()
    }
  }

  private async getCaps(): Promise<void> {
    try {
      const r = await this.cmd('CAPA', true)
      for (const l of latin1(r.body ?? new Uint8Array(0)).split('\r\n')) if (l) this.caps.add(l.toUpperCase())
    } catch {
      // Old servers do not know CAPA.
    }
  }

  async login(user: string, password: string): Promise<void> {
    if (this.o.security === 'none') throw new Pop3Error('A password is not sent over a connection that is not encrypted', 'auth')
    if (/[\r\n\u0000]/.test(user + password)) throw new Pop3Error('The sign-in details contain a line break', 'auth')
    try {
      await this.cmd(`USER ${user}`)
      await this.cmd(`PASS ${password}`)
    } catch (e) {
      throw e instanceof Pop3Error && e.kind === 'refused' ? new Pop3Error(e.message || 'The server did not accept the sign-in', 'auth') : e
    }
  }

  /** Every message's number and its stable id. */
  async uidl(): Promise<{ n: number; id: string }[]> {
    const r = await this.cmd('UIDL', true)
    return latin1(r.body ?? new Uint8Array(0))
      .split('\r\n')
      .filter(Boolean)
      .flatMap((l) => {
        const [n, id] = l.split(' ')
        return n && id ? [{ n: Number(n), id }] : []
      })
  }

  /** Every message's size in bytes, by number. */
  async sizes(): Promise<Map<number, number>> {
    const r = await this.cmd('LIST', true)
    const out = new Map<number, number>()
    for (const l of latin1(r.body ?? new Uint8Array(0)).split('\r\n')) {
      const [n, size] = l.split(' ')
      if (n && size) out.set(Number(n), Number(size))
    }
    return out
  }

  /** The headers of a message (and `lines` lines of its body). */
  async top(n: number, lines = 0): Promise<Uint8Array> {
    return (await this.cmd(`TOP ${n} ${lines}`, true)).body ?? new Uint8Array(0)
  }

  async retr(n: number): Promise<Uint8Array> {
    return (await this.cmd(`RETR ${n}`, true)).body ?? new Uint8Array(0)
  }

  /** Marks a message to be deleted; it goes when the session ends politely (`quit`). */
  async dele(n: number): Promise<void> {
    await this.cmd(`DELE ${n}`)
  }

  async quit(): Promise<void> {
    try {
      await this.cmd('QUIT')
    } catch {
      // The server hangs up as part of quitting.
    }
    this.socket?.close()
  }

  // ---- the conversation -------------------------------------------------------------------------------

  private cmd(line: string, multi = false): Promise<{ ok: boolean; text: string; body: Uint8Array | null }> {
    if (this.closed) return Promise.reject(this.closed)
    const socket = this.socket
    if (!socket) return Promise.reject(new Pop3Error('Not connected', 'closed'))
    const job = this.chain.then(() =>
      this.expect(multi, `The server did not answer ${line.split(' ')[0]}`, () => socket.write(enc.encode(`${line}\r\n`))).then((r) => {
        if (!r.ok) throw new Pop3Error(r.text || 'The server refused', 'refused')
        return r
      })
    )
    this.chain = job.catch(() => undefined)
    return job
  }

  private greeting() {
    return this.expect(false, 'The server did not greet us', () => undefined)
  }

  private expect(multi: boolean, timeoutMessage: string, send: () => void): Promise<{ ok: boolean; text: string; body: Uint8Array | null }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const e = new Pop3Error(timeoutMessage, 'timeout')
        this.end(e)
        reject(e)
      }, this.o.timeoutMs ?? 30_000)
      this.waiter = {
        multi,
        resolve: (r) => {
          clearTimeout(timer)
          resolve(r)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      }
      if (this.closed) return this.waiter.reject(this.closed)
      // A greeting may already have arrived.
      if (this.early && !multi) {
        const r = this.early
        this.early = null
        this.waiter = null
        clearTimeout(timer)
        return resolve({ ...r, body: null })
      }
      send()
      this.drain()
    })
  }

  private drain(): void {
    for (;;) {
      const end = this.crlf()
      if (end < 0) return
      const line = this.buf.slice(0, end)
      this.buf = this.buf.slice(end + 2)
      const w = this.waiter
      if (!w) {
        if (!this.greeted) {
          this.greeted = true;
          const t = latin1(line)
          this.early = { ok: t.startsWith('+OK'), text: t.replace(/^\+OK ?|^-ERR ?/, '') }
        }
        continue
      }
      if (!this.status) {
        this.greeted = true
        const t = latin1(line)
        const ok = t.startsWith('+OK')
        const text = t.replace(/^\+OK ?|^-ERR ?/, '')
        if (!ok || !w.multi) {
          this.waiter = null
          w.resolve({ ok, text, body: null })
        } else this.status = { ok, text }
        continue
      }
      // A line of a multi-line answer; a lone dot ends it, and a leading dot was doubled to hide it.
      if (line.length === 1 && line[0] === 46) {
        const st = this.status
        const parts = this.lines
        this.status = null
        this.lines = []
        this.waiter = null
        w.resolve({ ...st, body: join(parts) })
      } else this.lines.push(line.length >= 2 && line[0] === 46 && line[1] === 46 ? line.slice(1) : line)
    }
  }

  private crlf(): number {
    for (let i = 0; i < this.buf.length - 1; i++) if (this.buf[i] === 13 && this.buf[i + 1] === 10) return i
    return -1
  }

  private end(e: Error): void {
    if (this.closed) return
    this.closed = e
    const w = this.waiter
    this.waiter = null
    w?.reject(e)
    this.socket?.close()
  }
}

/** Lines back into one message, with CRLF between them and after the last. */
function join(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length + 2, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
    out[at++] = 13
    out[at++] = 10
  }
  return out
}

/**
 * Brings the saved copy of a POP3 inbox up to date: new messages are fetched (headers only, newest `window` at first),
 * messages the server no longer has are dropped. POP3 has no read marks, so a message keeps whatever mark was set here.
 * Each message gets a number of this device's making, remembered with its UIDL.
 */
export async function syncPop3(client: Pick<Pop3Client, 'uidl' | 'sizes' | 'top'>, cache: MailCache, account: string, folder: string, opts: { window?: number; now?: () => number } = {}): Promise<SyncResult> {
  const window = opts.window ?? 200
  const now = opts.now ?? Date.now
  const [listed, saved, state] = await Promise.all([client.uidl(), cache.summaries(account, folder), cache.folderState(account, folder)])
  const present = new Set(listed.map((m) => m.id))
  const byRemote = new Map(saved.filter((m) => m.remoteId).map((m) => [m.remoteId!, m]))
  const gone = saved.filter((m) => !m.remoteId || !present.has(m.remoteId)).map((m) => m.uid)
  if (gone.length > 0) await cache.remove(account, folder, gone)

  const fresh = listed.filter((m) => !byRemote.has(m.id)).slice(-window)
  const sizes = fresh.length > 0 ? await client.sizes() : new Map<number, number>()
  let next = state?.highestUid ?? 0
  const added: Summary[] = []
  for (const m of fresh) {
    const header = latin1(await client.top(m.n, 0))
    added.push(await parseSummary({ uid: ++next, flags: [], internalDate: null, size: sizes.get(m.n) ?? 0, remoteId: m.id }, header))
  }
  if (added.length > 0) await cache.upsert(account, folder, added)
  await cache.setFolderState(account, folder, { uidValidity: 1, highestUid: next, syncedAt: now() })
  return { added: added.length, removed: gone.length, flagsChanged: 0, reset: false }
}
