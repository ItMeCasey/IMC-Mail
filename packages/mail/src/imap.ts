import type { Connect, MailSocket, Security } from './socket'
import { parseSummary } from './summary'
import { asText, decodeMutf7, pairs, parseNode, ResponseReader, type Node, type RawResponse } from './imap-parse'

export interface ImapOptions {
  host: string
  port: number
  security: Security
  /** How long to wait for the server to answer one command. */
  timeoutMs?: number
}

export type SpecialUse = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'all' | 'flagged'

export interface Folder {
  /** The name as the server knows it; give this back to `select`. */
  path: string
  /** The name to show. */
  name: string
  delimiter: string | null
  flags: string[]
  specialUse: SpecialUse | null
  selectable: boolean
}

export interface MailboxState {
  exists: number
  uidValidity: number
  uidNext: number
}

export interface Address {
  name: string
  address: string
}

export interface Summary {
  uid: number
  flags: string[]
  /** When the server received it, as text, or null. */
  internalDate: string | null
  size: number
  from: Address | null
  to: Address[]
  cc: Address[]
  subject: string
  messageId: string | null
  inReplyTo: string | null
  references: string[]
  /** The Date header, epoch ms, or null if missing or unreadable. */
  date: number | null
  /** The message's id on a server without stable numbers (POP3's UIDL); the uid is then a number this device made up. */
  remoteId?: string
}

export class ImapError extends Error {
  constructor(
    message: string,
    readonly kind: 'no' | 'bad' | 'closed' | 'timeout' | 'protocol' | 'auth'
  ) {
    super(message)
  }
}

interface Reply {
  status: 'OK' | 'NO' | 'BAD'
  /** The text after the status, which may carry a [CODE]. */
  text: string
  untagged: RawResponse[]
}

interface Pending {
  tag: string
  untagged: RawResponse[]
  continuation: ((count: number) => string | Uint8Array) | undefined
  continuations: number
  done: (r: Reply) => void
  fail: (e: Error) => void
  /** For IDLE: told about each untagged reply as it arrives. */
  onUntagged?: (r: RawResponse) => void
  /** For IDLE: called when the server says it is waiting ("+ idling"), instead of answering it. */
  onContinue?: () => void
}

const SPECIAL: Record<string, SpecialUse> = {
  '\\sent': 'sent',
  '\\drafts': 'drafts',
  '\\trash': 'trash',
  '\\junk': 'junk',
  '\\spam': 'junk',
  '\\archive': 'archive',
  '\\all': 'all',
  '\\flagged': 'flagged'
}

const HEADER_FIELDS = 'FROM TO CC SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES'
const enc = new TextEncoder()

/** A string safe to put in a command: quoted, with nothing that could start a second command. */
export function quote(s: string): string {
  if (/[\u0000\r\n]/.test(s)) throw new ImapError('A value contains a line break', 'protocol')
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '=') + (i + 2 < bytes.length ? B64[n & 63]! : '=')
  }
  return out
}

/** A set of message numbers as IMAP writes it: 1,2,5:9. */
export function uidSet(uids: number[]): string {
  const sorted = [...new Set(uids)].sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < sorted.length; ) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++
    parts.push(j > i ? `${sorted[i]}:${sorted[j]}` : String(sorted[i]))
    i = j + 1
  }
  return parts.join(',')
}

/**
 * A small IMAP client: enough to sign in (password or OAuth), list folders, read headers and whole
 * messages, and change flags. The connection is passed in, so the same code runs on a phone and in tests.
 */
export class ImapClient {
  private socket: MailSocket | null = null
  private reader = new ResponseReader()
  private pending: Pending | null = null
  private greeting: ((r: RawResponse) => void) | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private tags = 0
  private closed: Error | null = null
  private caps = new Set<string>()
  private wakeIdle: (() => void) | null = null

  constructor(
    private connect: Connect,
    private o: ImapOptions
  ) {}

  get capabilities(): ReadonlySet<string> {
    return this.caps
  }

  /** Connects and reads the greeting, upgrading to TLS first when the account asks for STARTTLS. */
  async open(): Promise<void> {
    const socket = await this.connect(this.o.host, this.o.port, this.o.security === 'tls')
    this.socket = socket
    // Be ready for the greeting before listening: it may already be waiting.
    const greeted = new Promise<RawResponse>((resolve) => (this.greeting = resolve))
    socket.onData((chunk) => {
      this.reader.push(chunk)
      this.drain()
    })
    socket.onClose((e) => this.end(e ?? new ImapError('The connection closed', 'closed')))
    const hello = await this.within(greeted, 'The server did not greet us')
    if (/^\* BYE/i.test(hello.text)) throw new ImapError(`The server refused the connection: ${hello.text.slice(6)}`, 'closed')
    this.noteCapabilities(hello.text)
    if (this.o.security === 'starttls') {
      if (this.caps.size === 0) await this.capability()
      if (!this.caps.has('STARTTLS')) throw new ImapError('The server does not offer STARTTLS, so the connection would not be private', 'protocol')
      await this.run('STARTTLS')
      await socket.startTls()
      this.caps.clear()
    }
    if (this.caps.size === 0 || this.o.security === 'starttls') await this.capability()
  }

  async capability(): Promise<ReadonlySet<string>> {
    const r = await this.run('CAPABILITY')
    this.caps.clear()
    for (const u of r.untagged) this.noteCapabilities(u.text)
    return this.caps
  }

  async login(user: string, password: string): Promise<void> {
    if (this.caps.has('LOGINDISABLED')) throw new ImapError('This server does not allow a password sign-in on an unencrypted connection', 'auth')
    await this.authed(() => this.run(`LOGIN ${quote(user)} ${quote(password)}`))
  }

  /** Signs in with an OAuth access token (Gmail, Outlook). */
  async authXoauth2(user: string, accessToken: string): Promise<void> {
    if (/[\u0000-\u001f]/.test(user + accessToken)) throw new ImapError('The sign-in details contain a control character', 'auth')
    const ir = base64(enc.encode(`user=${user}\u0001auth=Bearer ${accessToken}\u0001\u0001`))
    const sasl = this.caps.has('SASL-IR')
    await this.authed(() =>
      this.run(sasl ? `AUTHENTICATE XOAUTH2 ${ir}` : 'AUTHENTICATE XOAUTH2', {
        // A first "+" asks for the credentials (or, after we sent them, carries an error: answer with an empty line to get the verdict).
        continuation: (n) => (!sasl && n === 0 ? ir : '')
      })
    )
  }

  private async authed(go: () => Promise<Reply>): Promise<void> {
    try {
      const r = await go()
      for (const u of r.untagged) this.noteCapabilities(u.text)
      if (/\[CAPABILITY /i.test(r.text)) this.noteCapabilities(`* ${r.text}`)
      else await this.capability()
    } catch (e) {
      if (e instanceof ImapError && (e.kind === 'no' || e.kind === 'bad')) throw new ImapError(e.message || 'The server did not accept the sign-in', 'auth')
      throw e
    }
  }

  async list(): Promise<Folder[]> {
    const r = await this.run('LIST "" "*"')
    const out: Folder[] = []
    for (const u of r.untagged) {
      if (!/^\* LIST /i.test(u.text)) continue
      const flags = parseNode(u.text, u.literals, 7)
      if (!Array.isArray(flags.node)) continue
      const delim = parseNode(u.text, u.literals, flags.end)
      const nameNode = parseNode(u.text, u.literals, delim.end)
      const path = asText(nameNode.node)
      const f = flags.node.filter((x): x is string => typeof x === 'string')
      const lower = f.map((x) => x.toLowerCase())
      const use = path.toUpperCase() === 'INBOX' ? 'inbox' : (lower.map((x) => SPECIAL[x]).find(Boolean) ?? null)
      const delimiter = typeof delim.node === 'string' ? delim.node : null
      out.push({
        path,
        name: decodeMutf7(delimiter && path.includes(delimiter) ? path.slice(path.lastIndexOf(delimiter) + 1) : path),
        delimiter,
        flags: f,
        specialUse: use,
        selectable: !lower.includes('\\noselect') && !lower.includes('\\nonexistent')
      })
    }
    return out
  }

  /** Opens a folder (read-only unless asked otherwise) and returns its counts. */
  async select(path: string, readOnly = true): Promise<MailboxState> {
    const r = await this.run(`${readOnly ? 'EXAMINE' : 'SELECT'} ${quote(path)}`)
    const state = { exists: 0, uidValidity: 0, uidNext: 0 }
    for (const u of r.untagged) {
      const exists = /^\* (\d+) EXISTS/i.exec(u.text)
      if (exists) state.exists = Number(exists[1])
      const validity = /\[UIDVALIDITY (\d+)\]/i.exec(u.text)
      if (validity) state.uidValidity = Number(validity[1])
      const next = /\[UIDNEXT (\d+)\]/i.exec(u.text)
      if (next) state.uidNext = Number(next[1])
    }
    return state
  }

  /** The uids of messages matching a search (everything by default), oldest first. */
  async searchUids(criteria = 'ALL'): Promise<number[]> {
    const r = await this.run(`UID SEARCH ${criteria}`)
    const out: number[] = []
    for (const u of r.untagged) {
      const m = /^\* SEARCH ?(.*)$/i.exec(u.text)
      if (m?.[1]) out.push(...m[1].split(' ').filter(Boolean).map(Number))
    }
    return out.sort((a, b) => a - b)
  }

  /** Headers, flags and size for these messages, without marking anything as read. */
  async fetchSummaries(uids: number[]): Promise<Summary[]> {
    const out: Summary[] = []
    for (let i = 0; i < uids.length; i += 100) {
      const set = uidSet(uids.slice(i, i + 100))
      const r = await this.run(`UID FETCH ${set} (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (${HEADER_FIELDS})])`)
      for (const u of r.untagged) {
        const f = this.fetched(u)
        if (!f) continue
        const headerKey = [...f.keys()].find((k) => k.startsWith('BODY[HEADER'))
        const header = headerKey ? asText(f.get(headerKey)) : ''
        out.push(await this.summary(f, header))
      }
    }
    return out.sort((a, b) => a.uid - b.uid)
  }

  /** The message as the server stores it, or just its first `maxBytes` when given (a huge attachment need not come down). */
  async fetchRaw(uid: number, maxBytes?: number): Promise<Uint8Array> {
    const r = await this.run(`UID FETCH ${uid} (BODY.PEEK[]${maxBytes ? `<0.${Math.max(1, Math.floor(maxBytes))}>` : ''})`)
    for (const u of r.untagged) {
      const f = this.fetched(u)
      const key = f && [...f.keys()].find((k) => k.startsWith('BODY[]'))
      const body = key ? f.get(key) : undefined
      if (body instanceof Uint8Array) return body
    }
    throw new ImapError(`Message ${uid} is not on the server any more`, 'no')
  }

  /** The current flags of these messages. */
  async fetchFlags(uids: number[]): Promise<Map<number, string[]>> {
    const out = new Map<number, string[]>()
    for (let i = 0; i < uids.length; i += 200) {
      const r = await this.run(`UID FETCH ${uidSet(uids.slice(i, i + 200))} (UID FLAGS)`)
      for (const u of r.untagged) {
        const f = this.fetched(u)
        const uid = Number(asText(f?.get('UID')))
        if (f && uid) out.set(uid, this.flagList(f.get('FLAGS')))
      }
    }
    return out
  }

  async setFlags(uids: number[], change: { add?: string[]; remove?: string[] }): Promise<void> {
    if (uids.length === 0) return
    const set = uidSet(uids)
    // Only plain flag names go into the command; anything else is dropped rather than sent.
    const clean = (l: string[] = []) => l.filter((f) => /^\\?[A-Za-z0-9$_-]+$/.test(f)).join(' ')
    const add = clean(change.add)
    const remove = clean(change.remove)
    if (add) await this.run(`UID STORE ${set} +FLAGS.SILENT (${add})`)
    if (remove) await this.run(`UID STORE ${set} -FLAGS.SILENT (${remove})`)
  }

  /**
   * Moves messages to another folder: with MOVE when the server has it, otherwise by copying them and then removing the
   * originals. The folder they are in must be open for writing (`select(path, false)`).
   */
  async move(uids: number[], destination: string): Promise<void> {
    if (uids.length === 0) return
    const set = uidSet(uids)
    if (this.caps.has('MOVE')) {
      await this.run(`UID MOVE ${set} ${quote(destination)}`)
      return
    }
    await this.run(`UID COPY ${set} ${quote(destination)}`)
    await this.deleteForever(uids)
  }

  /** Removes messages from the open folder for good (moving to Trash is what keeps them). */
  async deleteForever(uids: number[]): Promise<void> {
    if (uids.length === 0) return
    const set = uidSet(uids)
    await this.run(`UID STORE ${set} +FLAGS.SILENT (\\Deleted)`)
    // UIDPLUS removes just these. Without it every message marked deleted in the folder goes.
    await this.run(this.caps.has('UIDPLUS') ? `UID EXPUNGE ${set}` : 'EXPUNGE')
  }

  /** Saves a message in a folder (a copy in Sent, say). */
  async append(folder: string, raw: Uint8Array, flags: string[] = ['\\Seen']): Promise<void> {
    const clean = flags.filter((f) => /^\\?[A-Za-z0-9$_-]+$/.test(f)).join(' ')
    await this.run(`APPEND ${quote(folder)}${clean ? ` (${clean})` : ''} {${raw.length}}`, { continuation: () => raw })
  }

  /**
   * Waits on the open folder for news (IDLE): returns 'changed' when the server reports new mail, mail removed or flags
   * changed, and 'quiet' after `maxMs` with none (servers drop an idle connection after about half an hour, so ask
   * again before then). `wake()` ends it early with 'quiet'. After either answer the connection is ready for ordinary
   * commands again.
   */
  idle(maxMs: number): Promise<'changed' | 'quiet'> {
    const job = this.chain.then(
      () =>
        new Promise<'changed' | 'quiet'>((resolve, reject) => {
          if (this.closed) return reject(this.closed)
          const socket = this.socket
          if (!socket) return reject(new ImapError('Not connected', 'closed'))
          if (!this.caps.has('IDLE')) return reject(new ImapError('This server cannot wait for new mail (no IDLE)', 'protocol'))
          const tag = `A${String(++this.tags).padStart(4, '0')}`
          let outcome: 'changed' | 'quiet' = 'quiet'
          let stopped = false
          const stop = (why: 'changed' | 'quiet') => {
            if (stopped) return
            stopped = true
            outcome = why
            clearTimeout(timer)
            this.wakeIdle = null
            socket.write(enc.encode('DONE\r\n'))
          }
          const timer = setTimeout(() => stop('quiet'), maxMs)
          this.wakeIdle = () => stop('quiet')
          this.pending = {
            tag,
            untagged: [],
            continuation: undefined,
            continuations: 0,
            done: () => {
              clearTimeout(timer)
              this.wakeIdle = null
              resolve(outcome)
            },
            fail: (e) => {
              clearTimeout(timer)
              this.wakeIdle = null
              reject(e)
            },
            onContinue: () => undefined,
            onUntagged: (r) => {
              if (/^\* \d+ (EXISTS|EXPUNGE|FETCH|RECENT)\b/i.test(r.text)) stop('changed')
            }
          }
          socket.write(enc.encode(`${tag} IDLE\r\n`))
        })
    )
    this.chain = job.catch(() => undefined)
    return job
  }

  /** Ends a wait started with `idle` right away. */
  wake(): void {
    this.wakeIdle?.()
  }

  async logout(): Promise<void> {
    try {
      await this.run('LOGOUT')
    } catch {
      // The server hangs up as part of logging out.
    }
    this.socket?.close()
  }

  // ---- reading replies --------------------------------------------------------------------------------

  private fetched(u: RawResponse): Map<string, Node> | null {
    const head = /^\* \d+ FETCH /i.exec(u.text)
    if (!head) return null
    const { node } = parseNode(u.text, u.literals, head[0].length)
    return Array.isArray(node) ? pairs(node) : null
  }

  private flagList(n: Node | undefined): string[] {
    return Array.isArray(n) ? n.filter((x): x is string => typeof x === 'string') : []
  }

  private async summary(f: Map<string, Node>, header: string): Promise<Summary> {
    return parseSummary(
      {
        uid: Number(asText(f.get('UID'))),
        flags: this.flagList(f.get('FLAGS')),
        internalDate: asText(f.get('INTERNALDATE')) || null,
        size: Number(asText(f.get('RFC822.SIZE'))) || 0
      },
      header
    )
  }

  private noteCapabilities(line: string): void {
    const m = /(?:^\* CAPABILITY |\[CAPABILITY )([^\]]*)/i.exec(line)
    if (m?.[1]) for (const c of m[1].trim().split(/\s+/)) this.caps.add(c.toUpperCase())
  }

  // ---- the command loop -------------------------------------------------------------------------------

  /** Sends one command and waits for its verdict. Commands go one at a time, in order. */
  private run(command: string, opts: { continuation?: (count: number) => string | Uint8Array } = {}): Promise<Reply> {
    const job = this.chain.then(() => this.exchange(command, opts))
    this.chain = job.catch(() => undefined)
    return job
  }

  private exchange(command: string, opts: { continuation?: (count: number) => string | Uint8Array }): Promise<Reply> {
    if (this.closed) return Promise.reject(this.closed)
    const socket = this.socket
    if (!socket) return Promise.reject(new ImapError('Not connected', 'closed'))
    const tag = `A${String(++this.tags).padStart(4, '0')}`
    return this.within(
      new Promise<Reply>((done, fail) => {
        this.pending = { tag, untagged: [], continuation: opts.continuation, continuations: 0, done, fail }
        socket.write(enc.encode(`${tag} ${command}\r\n`))
      }),
      `The server did not answer ${command.split(' ')[0]}`
    )
  }

  private within<T>(p: Promise<T>, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const e = new ImapError(message, 'timeout')
        // The state of the connection is unknown now; do not reuse it.
        this.end(e)
        reject(e)
      }, this.o.timeoutMs ?? 30_000)
    })
    return Promise.race([p, limit]).finally(() => clearTimeout(timer))
  }

  private drain(): void {
    for (let r = this.reader.next(); r; r = this.reader.next()) this.handle(r)
  }

  private handle(r: RawResponse): void {
    if (this.greeting && r.text.startsWith('* ')) {
      const g = this.greeting
      this.greeting = null
      g(r)
      return
    }
    const p = this.pending
    if (!p) return
    if (r.text.startsWith('+')) {
      if (p.onContinue) return p.onContinue()
      const line = p.continuation?.(p.continuations++) ?? ''
      if (typeof line === 'string') this.socket?.write(enc.encode(`${line}\r\n`))
      else {
        // Bytes (a message being saved), followed by the line end that finishes the command.
        const out = new Uint8Array(line.length + 2)
        out.set(line)
        out.set([13, 10], line.length)
        this.socket?.write(out)
      }
      return
    }
    if (r.text.startsWith(`${p.tag} `)) {
      this.pending = null
      const m = /^\S+ (OK|NO|BAD)\b ?(.*)$/is.exec(r.text)
      if (!m) return p.fail(new ImapError('The server sent something unexpected', 'protocol'))
      const status = m[1]!.toUpperCase() as Reply['status']
      if (status === 'OK') p.done({ status, text: m[2] ?? '', untagged: p.untagged })
      else p.fail(new ImapError((m[2] ?? '').replace(/^\[[^\]]*\]\s*/, '') || (status === 'NO' ? 'The server refused' : 'The server did not understand'), status === 'NO' ? 'no' : 'bad'))
      return
    }
    if (r.text.startsWith('* BYE')) return
    p.untagged.push(r)
    p.onUntagged?.(r)
  }

  private end(e: Error): void {
    if (this.closed) return
    this.closed = e
    const p = this.pending
    this.pending = null
    p?.fail(e)
    this.socket?.close()
  }
}
