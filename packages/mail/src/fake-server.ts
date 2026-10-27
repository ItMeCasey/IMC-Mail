import type { Connect, MailSocket } from './socket'

// A small IMAP server that lives in memory, for tests. It speaks just enough of the protocol to exercise
// the client, and records what the client sent so tests can check it.

export interface FakeMessage {
  uid: number
  flags?: string[]
  internalDate?: string
  /** The whole message, with CRLF line ends. */
  raw: string
}

export interface FakeFolder {
  path: string
  /** The raw LIST attributes, e.g. ['\\HasNoChildren', '\\Sent']. */
  attrs?: string[]
  delimiter?: string | null
  /** Written into the LIST reply as is (for literals and odd quoting). */
  listName?: string
  uidValidity?: number
  messages?: FakeMessage[]
}

export interface FakeOptions {
  capabilities?: string[]
  /** Capabilities that appear in the greeting itself. */
  greetingCaps?: boolean
  folders?: FakeFolder[]
  user?: string
  password?: string
  token?: string
  /** Never answer commands (for timeouts). */
  silent?: boolean
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export class FakeServer {
  readonly received: string[] = []
  tlsStarted = false
  closedByClient = false
  private selected: FakeFolder | null = null
  private authed = false
  private sock: { push: (b: Uint8Array) => void; close: () => void } | null = null
  private waitingForSasl: { tag: string } | null = null
  private inbound = ''

  constructor(readonly o: FakeOptions = {}) {}

  get caps(): string[] {
    return this.o.capabilities ?? ['IMAP4rev1', 'SASL-IR', 'AUTH=XOAUTH2']
  }

  /** A `Connect` that opens a connection to this server. */
  get connect(): Connect {
    return async (_host, _port, tls) => {
      this.tlsStarted = tls
      // Like a real socket, keep what arrives before anyone is listening.
      let onData: ((c: Uint8Array) => void) | null = null
      const early: Uint8Array[] = []
      let onClose: (e?: Error) => void = () => {}
      const server = this
      const socket: MailSocket = {
        write: (d) => server.input(dec.decode(d)),
        onData: (cb) => {
          onData = cb
          for (const c of early.splice(0)) cb(c)
        },
        onClose: (cb) => (onClose = cb),
        startTls: async () => {
          server.tlsStarted = true
        },
        close: () => {
          server.closedByClient = true
        }
      }
      this.sock = { push: (b) => (onData ? onData(b) : early.push(b)), close: () => onClose() }
      queueMicrotask(() => this.say(`* OK ${this.o.greetingCaps ? `[CAPABILITY ${this.caps.join(' ')}] ` : ''}fake ready\r\n`))
      return socket
    }
  }

  /** Drops the connection from the server side. */
  hangUp(): void {
    this.sock?.close()
  }

  /** Sends text to the client as it arrives, split into pieces of this many bytes (to test reassembly). */
  chunk = 0

  say(s: string | Uint8Array): void {
    const bytes = typeof s === 'string' ? enc.encode(s) : s
    if (this.chunk > 0) for (let i = 0; i < bytes.length; i += this.chunk) this.sock?.push(bytes.slice(i, i + this.chunk))
    else this.sock?.push(bytes)
  }

  private input(s: string): void {
    this.inbound += s
    for (;;) {
      const end = this.inbound.indexOf('\r\n')
      if (end < 0) return
      const line = this.inbound.slice(0, end)
      this.inbound = this.inbound.slice(end + 2)
      this.received.push(line)
      if (!this.o.silent) this.command(line)
    }
  }

  private command(line: string): void {
    if (this.waitingForSasl) {
      const { tag } = this.waitingForSasl
      this.waitingForSasl = null
      // A line that follows a "+": either the credentials, or the empty acknowledgement of an error.
      if (line === '') return this.say(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`)
      return this.finishXoauth(tag, line)
    }
    const m = /^(\S+) (\S+)(?: (.*))?$/.exec(line)
    if (!m) return
    const [, tag, verbRaw, args = ''] = m
    const verb = verbRaw!.toUpperCase()
    switch (verb) {
      case 'CAPABILITY':
        return this.say(`* CAPABILITY ${this.caps.join(' ')}\r\n${tag} OK done\r\n`)
      case 'STARTTLS':
        return this.say(`${tag} OK Begin TLS\r\n`)
      case 'LOGIN': {
        const [u, p] = [...args.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]!.replace(/\\(.)/g, '$1'))
        if (u === this.o.user && p === this.o.password) {
          this.authed = true
          return this.say(`${tag} OK [CAPABILITY IMAP4rev1] logged in\r\n`)
        }
        return this.say(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`)
      }
      case 'AUTHENTICATE': {
        const [, mech, ir] = args.split(' ')
        void mech
        if (!args.toUpperCase().startsWith('XOAUTH2')) return this.say(`${tag} NO unsupported\r\n`)
        const payload = args.split(' ')[1]
        if (payload) return this.finishXoauth(tag!, payload)
        void ir
        this.waitingForSasl = { tag: tag! }
        return this.say('+ \r\n')
      }
      case 'LIST':
        return this.list(tag!)
      case 'SELECT':
      case 'EXAMINE': {
        const path = /"((?:[^"\\]|\\.)*)"/.exec(args)?.[1]?.replace(/\\(.)/g, '$1')
        const f = this.o.folders?.find((x) => x.path === path)
        if (!this.authed || !f) return this.say(`${tag} NO no such mailbox\r\n`)
        this.selected = f
        const msgs = f.messages ?? []
        const next = Math.max(0, ...msgs.map((x) => x.uid)) + 1
        return this.say(`* ${msgs.length} EXISTS\r\n* OK [UIDVALIDITY ${f.uidValidity ?? 1}] ok\r\n* OK [UIDNEXT ${next}] ok\r\n${tag} OK [READ-ONLY] done\r\n`)
      }
      case 'UID':
        return this.uid(tag!, args)
      case 'LOGOUT':
        this.say(`* BYE bye\r\n${tag} OK logged out\r\n`)
        return
      default:
        return this.say(`${tag} BAD unknown command\r\n`)
    }
  }

  private finishXoauth(tag: string, payload: string): void {
    const text = atob(payload)
    this.received.push(`(decoded) ${text.replace(/\u0001/g, '^A')}`)
    if (text === `user=${this.o.user}\u0001auth=Bearer ${this.o.token}\u0001\u0001`) {
      this.authed = true
      return this.say(`${tag} OK [CAPABILITY IMAP4rev1] authenticated\r\n`)
    }
    // Real servers send a JSON error after a "+" and wait for an empty line before the verdict.
    this.waitingForSasl = { tag }
    this.say(`+ ${btoa('{"status":"401","schemes":"Bearer"}')}\r\n`)
  }

  private list(tag: string): void {
    if (!this.authed) return this.say(`${tag} NO not signed in\r\n`)
    let out = ''
    for (const f of this.o.folders ?? []) {
      const delim = f.delimiter === null ? 'NIL' : `"${f.delimiter ?? '/'}"`
      out += `* LIST (${(f.attrs ?? []).join(' ')}) ${delim} ${f.listName ?? `"${f.path}"`}\r\n`
    }
    this.say(`${out}${tag} OK done\r\n`)
  }

  private uid(tag: string, args: string): void {
    const f = this.selected
    if (!this.authed || !f) return this.say(`${tag} NO select a mailbox first\r\n`)
    const msgs = f.messages ?? []
    const search = /^SEARCH (.*)$/i.exec(args)
    if (search) return this.say(`* SEARCH ${msgs.map((m) => m.uid).join(' ')}\r\n${tag} OK done\r\n`)
    const store = /^STORE (\S+) ([+-])FLAGS\.SILENT \(([^)]*)\)$/i.exec(args)
    if (store) {
      for (const m of this.pick(msgs, store[1]!)) {
        const set = new Set(m.flags ?? [])
        for (const fl of store[3]!.split(' ').filter(Boolean)) store[2] === '+' ? set.add(fl) : set.delete(fl)
        m.flags = [...set]
      }
      return this.say(`${tag} OK done\r\n`)
    }
    const fetch = /^FETCH (\S+) \((.*)\)$/i.exec(args)
    if (!fetch) return this.say(`${tag} BAD unsupported\r\n`)
    const items = fetch[2]!
    let out = ''
    for (const m of this.pick(msgs, fetch[1]!)) {
      const flags = `(${(m.flags ?? []).join(' ')})`
      if (/BODY\.PEEK\[\]/i.test(items)) {
        const part = /<0\.(\d+)>/.exec(items)
        let bytes = enc.encode(m.raw)
        if (part) bytes = bytes.slice(0, Number(part[1]))
        out += `* ${m.uid} FETCH (UID ${m.uid} ${part ? 'BODY[]<0>' : 'BODY[]'} {${bytes.length}}\r\n${dec.decode(bytes)})\r\n`
      } else if (/HEADER\.FIELDS/i.test(items)) {
        const want = /HEADER\.FIELDS \(([^)]*)\)/i.exec(items)![1]!.split(' ').map((x) => x.toLowerCase())
        const head = m.raw.split('\r\n\r\n')[0]!.replace(/\r\n[ \t]/g, '\u0002')
        const kept = head
          .split('\r\n')
          .filter((l) => want.includes(l.split(':')[0]!.toLowerCase()))
          .map((l) => l.replace(/\u0002/g, '\r\n '))
          .join('\r\n')
        const block = `${kept}\r\n\r\n`
        out += `* ${m.uid} FETCH (UID ${m.uid} FLAGS ${flags} INTERNALDATE "${m.internalDate ?? '03-Nov-2026 15:00:00 +0000'}" RFC822.SIZE ${enc.encode(m.raw).length} BODY[HEADER.FIELDS (${items.match(/HEADER\.FIELDS \(([^)]*)\)/i)![1]})] {${enc.encode(block).length}}\r\n${block})\r\n`
      } else {
        out += `* ${m.uid} FETCH (UID ${m.uid} FLAGS ${flags})\r\n`
      }
    }
    this.say(`${out}${tag} OK done\r\n`)
  }

  /** Messages in a set like 1,3:5. */
  private pick(msgs: FakeMessage[], set: string): FakeMessage[] {
    const ids = new Set<number>()
    for (const part of set.split(',')) {
      const [a, b] = part.split(':').map(Number)
      for (let i = a!; i <= (b ?? a!); i++) ids.add(i)
    }
    return msgs.filter((m) => ids.has(m.uid))
  }
}
