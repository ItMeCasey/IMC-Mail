import type { Connect, MailSocket } from './socket'

// A small SMTP server that lives in memory, for tests. It records what the client sent.

export interface FakeSmtpOptions {
  user?: string
  password?: string
  token?: string
  /** Capabilities announced after the first line of EHLO. */
  capabilities?: string[]
  /** Addresses RCPT TO refuses. */
  refuse?: string[]
  /** Never answer after the greeting (for timeouts). */
  silent?: boolean
  /** Refuse the message after DATA with this reply. */
  rejectData?: string
}

export interface SentMessage {
  from: string
  to: string[]
  raw: string
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export class FakeSmtp {
  readonly lines: string[] = []
  readonly messages: SentMessage[] = []
  tlsStarted = false
  private authed = false
  private from = ''
  private to: string[] = []
  private data: string[] | null = null
  private awaitingSasl = false
  private inbound = ''
  private push: ((b: Uint8Array) => void) | null = null
  private close: (() => void) | null = null

  constructor(readonly o: FakeSmtpOptions = {}) {}

  get connect(): Connect {
    return async (_host, _port, tls) => {
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
      queueMicrotask(() => this.say('220 fake ESMTP ready'))
      return socket
    }
  }

  hangUp(): void {
    this.close?.()
  }

  private say(text: string): void {
    this.push?.(enc.encode(`${text}\r\n`))
  }

  private input(text: string): void {
    this.inbound += text
    if (this.data) {
      const end = this.inbound.indexOf('\r\n.\r\n')
      const alone = this.inbound === '.\r\n' || this.inbound.startsWith('.\r\n') ? 0 : -1
      const stop = end >= 0 ? end + 2 : alone >= 0 ? 0 : -1
      if (stop < 0) return
      const body = this.inbound.slice(0, stop)
      this.inbound = ''
      // Undo the dot-stuffing.
      const raw = body.replace(/(^|\r\n)\.\./g, '$1.')
      this.data = null
      if (this.o.rejectData) return this.say(this.o.rejectData)
      this.messages.push({ from: this.from, to: this.to, raw })
      return this.say('250 2.0.0 queued')
    }
    for (;;) {
      const end = this.inbound.indexOf('\r\n')
      if (end < 0) return
      const line = this.inbound.slice(0, end)
      this.inbound = this.inbound.slice(end + 2)
      this.lines.push(line)
      if (!this.o.silent) this.command(line)
      if (this.data) {
        // The rest of the buffer is message text.
        if (this.inbound) this.input('')
        return
      }
    }
  }

  private command(line: string): void {
    if (this.awaitingSasl) {
      this.awaitingSasl = false
      return this.say('535 5.7.8 Authentication failed')
    }
    const [verb = '', ...rest] = line.split(' ')
    const args = rest.join(' ')
    switch (verb.toUpperCase()) {
      case 'EHLO': {
        const caps = this.o.capabilities ?? ['SIZE 1000000', 'AUTH PLAIN XOAUTH2']
        return this.say(['250-fake', ...caps.slice(0, -1).map((c) => `250-${c}`), `250 ${caps[caps.length - 1] ?? 'OK'}`].join('\r\n'))
      }
      case 'STARTTLS':
        return this.say('220 Ready to start TLS')
      case 'AUTH': {
        const [mech, payload] = args.split(' ')
        if (mech === 'PLAIN' && payload) {
          const [, u, p] = atob(payload).split('\u0000')
          if (u === this.o.user && p === this.o.password) {
            this.authed = true
            return this.say('235 2.7.0 Accepted')
          }
          return this.say('535 5.7.8 Authentication failed')
        }
        if (mech === 'XOAUTH2' && payload) {
          if (atob(payload) === `user=${this.o.user}\u0001auth=Bearer ${this.o.token}\u0001\u0001`) {
            this.authed = true
            return this.say('235 2.7.0 Accepted')
          }
          this.awaitingSasl = true
          return this.say(`334 ${btoa('{"status":"401"}')}`)
        }
        return this.say('504 unsupported')
      }
      case 'MAIL': {
        if (!this.authed) return this.say('530 5.7.0 Authentication required')
        this.from = /<([^>]*)>/.exec(args)?.[1] ?? ''
        this.to = []
        return this.say('250 OK')
      }
      case 'RCPT': {
        const a = /<([^>]*)>/.exec(args)?.[1] ?? ''
        if (this.o.refuse?.includes(a)) return this.say('550 5.1.1 No such user')
        this.to.push(a)
        return this.say('250 OK')
      }
      case 'DATA':
        this.data = []
        return this.say('354 End data with <CR><LF>.<CR><LF>')
      case 'QUIT':
        return this.say('221 Bye')
      default:
        return this.say('500 unknown command')
    }
  }
}
