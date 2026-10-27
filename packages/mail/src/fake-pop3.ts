import type { Connect, MailSocket } from './socket'

// A small POP3 server that lives in memory, for tests.

export interface FakePop3Options {
  user?: string
  password?: string
  /** The inbox: message text by UIDL. */
  messages?: { uidl: string; raw: string }[]
  capabilities?: string[]
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export class FakePop3 {
  readonly lines: string[] = []
  tlsStarted = false
  deleted = new Set<string>()
  private authedUser = false
  private authed = false
  private inbound = ''
  private push: ((b: Uint8Array) => void) | null = null
  private close: (() => void) | null = null

  constructor(readonly o: FakePop3Options = {}) {}

  get inbox() {
    return (this.o.messages ?? []).filter((m) => !this.deleted.has(m.uidl))
  }

  get connect(): Connect {
    return async (_h, _p, tls) => {
      this.tlsStarted = tls
      let onData: ((c: Uint8Array) => void) | null = null
      const early: Uint8Array[] = []
      let onClose: (e?: Error) => void = () => {}
      const self = this
      const socket: MailSocket = {
        write: (d) => self.input(dec.decode(d)),
        onData: (cb) => {
          onData = cb
          for (const c of early.splice(0)) cb(c)
        },
        onClose: (cb) => (onClose = cb),
        startTls: async () => {
          self.tlsStarted = true
        },
        close: () => {}
      }
      this.push = (b) => (onData ? onData(b) : early.push(b))
      this.close = () => onClose()
      queueMicrotask(() => this.say('+OK fake POP3 ready'))
      return socket
    }
  }

  hangUp(): void {
    this.close?.()
  }

  private say(text: string): void {
    this.push?.(enc.encode(`${text}\r\n`))
  }

  /** A multi-line answer: dot-stuffed, ended by a lone dot. */
  private multi(first: string, body: string[]): void {
    const lines = body.map((l) => (l.startsWith('.') ? `.${l}` : l))
    this.say([first, ...lines, '.'].join('\r\n'))
  }

  private input(text: string): void {
    this.inbound += text
    for (;;) {
      const end = this.inbound.indexOf('\r\n')
      if (end < 0) return
      const line = this.inbound.slice(0, end)
      this.inbound = this.inbound.slice(end + 2)
      this.lines.push(line)
      this.command(line)
    }
  }

  private command(line: string): void {
    const [verb = '', ...rest] = line.split(' ')
    const arg = rest.join(' ')
    switch (verb.toUpperCase()) {
      case 'CAPA':
        return this.multi('+OK capabilities', this.o.capabilities ?? ['USER', 'UIDL', 'TOP'])
      case 'STLS':
        return this.say('+OK begin TLS')
      case 'USER':
        this.authedUser = arg === this.o.user
        return this.say('+OK')
      case 'PASS':
        if (this.authedUser && arg === this.o.password) {
          this.authed = true
          return this.say('+OK welcome')
        }
        return this.say('-ERR invalid credentials')
      case 'UIDL':
        if (!this.authed) return this.say('-ERR not signed in')
        return this.multi('+OK', this.inbox.map((m, i) => `${i + 1} ${m.uidl}`))
      case 'LIST':
        if (!this.authed) return this.say('-ERR not signed in')
        return this.multi('+OK', this.inbox.map((m, i) => `${i + 1} ${enc.encode(m.raw).length}`))
      case 'TOP': {
        if (!this.authed) return this.say('-ERR not signed in')
        const m = this.inbox[Number(arg.split(' ')[0]) - 1]
        if (!m) return this.say('-ERR no such message')
        const head = m.raw.split('\r\n\r\n')[0]!
        return this.multi('+OK', [...head.split('\r\n'), ''])
      }
      case 'RETR': {
        if (!this.authed) return this.say('-ERR not signed in')
        const m = this.inbox[Number(arg) - 1]
        if (!m) return this.say('-ERR no such message')
        return this.multi('+OK', m.raw.split('\r\n'))
      }
      case 'DELE': {
        const m = this.inbox[Number(arg) - 1]
        if (!m) return this.say('-ERR no such message')
        this.deleted.add(m.uidl)
        return this.say('+OK deleted')
      }
      case 'QUIT':
        return this.say('+OK bye')
      default:
        return this.say('-ERR unknown command')
    }
  }
}
