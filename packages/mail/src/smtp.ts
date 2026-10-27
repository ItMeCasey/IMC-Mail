import type { Connect, MailSocket, Security } from './socket'

// Sending mail: a small SMTP client that signs in with a password or an OAuth token and hands over one message.
// Like the IMAP client it takes its connection as a parameter, so it runs on the phone and in tests.

export interface SmtpOptions {
  host: string
  port: number
  security: Security
  timeoutMs?: number
  /** The name this device gives in EHLO. */
  clientName?: string
}

export class SmtpError extends Error {
  constructor(
    message: string,
    readonly kind: 'rejected' | 'auth' | 'protocol' | 'closed' | 'timeout' | 'recipient',
    readonly code?: number
  ) {
    super(message)
  }
}

interface Reply {
  code: number
  /** The text of each line, without the code. */
  lines: string[]
}

const enc = new TextEncoder()
const dec = new TextDecoder()

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '=') + (i + 2 < bytes.length ? B64[n & 63]! : '=')
  }
  return out
}

/** An address as SMTP wants it in MAIL FROM and RCPT TO. Anything that could end the command or start another is refused. */
export function smtpAddress(addr: string): string {
  const a = addr.trim()
  if (!/^[^\s<>()\\",;:\u0000-\u001f]+@[^\s<>()\\",;:\u0000-\u001f]+$/.test(a)) throw new SmtpError(`"${addr}" is not an email address`, 'recipient')
  return `<${a}>`
}

/** Escapes a message for the DATA command: a line starting with "." gets another, so it cannot end the message early. */
export function dotStuff(raw: Uint8Array): Uint8Array {
  const out: number[] = []
  let atLineStart = true
  for (const b of raw) {
    if (atLineStart && b === 46) out.push(46)
    out.push(b)
    atLineStart = b === 10
  }
  return Uint8Array.from(out)
}

export class SmtpClient {
  private socket: MailSocket | null = null
  private buffer = ''
  private waiting: { resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null
  private replies: Reply[] = []
  private partial: string[] = []
  private closed: Error | null = null
  private caps = new Set<string>()
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    private connect: Connect,
    private o: SmtpOptions
  ) {}

  get capabilities(): ReadonlySet<string> {
    return this.caps
  }

  /** The largest message the server takes, in bytes, if it says. */
  get maxSize(): number | null {
    for (const c of this.caps) {
      const m = /^SIZE (\d+)$/.exec(c)
      if (m) return Number(m[1]) || null
    }
    return null
  }

  async open(): Promise<void> {
    const socket = await this.connect(this.o.host, this.o.port, this.o.security === 'tls')
    this.socket = socket
    socket.onData((chunk) => this.feed(dec.decode(chunk)))
    socket.onClose((e) => this.end(e ?? new SmtpError('The connection closed', 'closed')))
    const hello = await this.read('The server did not greet us')
    if (hello.code !== 220) throw new SmtpError(`The server refused the connection: ${hello.lines.join(' ')}`, 'closed', hello.code)
    await this.ehlo()
    if (this.o.security === 'starttls') {
      if (!this.caps.has('STARTTLS')) throw new SmtpError('The server does not offer STARTTLS, so the connection would not be private', 'protocol')
      await this.command('STARTTLS', [220])
      await socket.startTls()
      await this.ehlo()
    }
  }

  private async ehlo(): Promise<void> {
    const r = await this.command(`EHLO ${this.o.clientName ?? 'imc-mail.local'}`, [250])
    this.caps.clear()
    for (const l of r.lines.slice(1)) this.caps.add(l.toUpperCase())
  }

  /** Signs in with an OAuth token (Gmail, Outlook). */
  async authXoauth2(user: string, token: string): Promise<void> {
    if (/[\u0000-\u001f]/.test(user + token)) throw new SmtpError('The sign-in details contain a control character', 'auth')
    const ir = base64(enc.encode(`user=${user}\u0001auth=Bearer ${token}\u0001\u0001`))
    try {
      const r = await this.command(`AUTH XOAUTH2 ${ir}`, [235, 334])
      // A 334 carries a JSON error; an empty line gets the final verdict.
      if (r.code === 334) await this.command('', [235])
    } catch (e) {
      throw this.authFailure(e)
    }
  }

  /** Signs in with a user name and password. */
  async authPlain(user: string, password: string): Promise<void> {
    if (this.o.security === 'none') throw new SmtpError('A password is not sent over a connection that is not encrypted', 'auth')
    if (/[\u0000\r\n]/.test(user + password)) throw new SmtpError('The sign-in details contain a control character', 'auth')
    try {
      await this.command(`AUTH PLAIN ${base64(enc.encode(`\u0000${user}\u0000${password}`))}`, [235])
    } catch (e) {
      throw this.authFailure(e)
    }
  }

  private authFailure(e: unknown): Error {
    return e instanceof SmtpError && (e.kind === 'rejected' || e.kind === 'protocol') ? new SmtpError(e.message || 'The server did not accept the sign-in', 'auth', e.code) : (e as Error)
  }

  /** Sends one message. `recipients` is everyone it goes to, including Bcc, which is not in the message itself. */
  async send(from: string, recipients: string[], raw: Uint8Array): Promise<void> {
    if (recipients.length === 0) throw new SmtpError('There is nobody to send this to', 'recipient')
    const max = this.maxSize
    if (max !== null && raw.length > max) throw new SmtpError(`This message is ${Math.round(raw.length / 1_000_000)} MB, more than the ${Math.round(max / 1_000_000)} MB this server accepts`, 'rejected')
    await this.command(`MAIL FROM:${smtpAddress(from)}`, [250])
    for (const r of recipients) {
      try {
        await this.command(`RCPT TO:${smtpAddress(r)}`, [250, 251])
      } catch (e) {
        if (e instanceof SmtpError && e.kind === 'rejected') throw new SmtpError(`The server did not accept ${r}: ${e.message}`, 'recipient', e.code)
        throw e
      }
    }
    await this.command('DATA', [354])
    const body = dotStuff(raw)
    const tail = enc.encode(raw.length >= 2 && raw[raw.length - 2] === 13 && raw[raw.length - 1] === 10 ? '.\r\n' : '\r\n.\r\n')
    const all = new Uint8Array(body.length + tail.length)
    all.set(body)
    all.set(tail, body.length)
    await this.run(async () => {
      this.socket!.write(all)
      const r = await this.read('The server did not confirm the message')
      if (r.code !== 250) throw new SmtpError(r.lines.join(' ') || 'The server did not accept the message', 'rejected', r.code)
    })
  }

  async quit(): Promise<void> {
    try {
      await this.command('QUIT', [221])
    } catch {
      // The server hangs up as part of quitting.
    }
    this.socket?.close()
  }

  // ---- the conversation -------------------------------------------------------------------------------

  private command(line: string, accept: number[]): Promise<Reply> {
    return this.run(async () => {
      this.socket!.write(enc.encode(`${line}\r\n`))
      const r = await this.read(`The server did not answer ${line.split(' ')[0] || 'the sign-in'}`)
      if (!accept.includes(r.code)) throw new SmtpError(r.lines.join(' ') || `The server answered ${r.code}`, r.code >= 500 || r.code === 454 ? 'rejected' : 'protocol', r.code)
      return r
    })
  }

  private run<T>(job: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(this.closed)
    if (!this.socket) return Promise.reject(new SmtpError('Not connected', 'closed'))
    const result = this.chain.then(job)
    this.chain = result.catch(() => undefined)
    return result
  }

  private read(timeoutMessage: string): Promise<Reply> {
    const ready = this.replies.shift()
    if (ready) return Promise.resolve(ready)
    if (this.closed) return Promise.reject(this.closed)
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        const e = new SmtpError(timeoutMessage, 'timeout')
        this.end(e)
        reject(e)
      }, this.o.timeoutMs ?? 30_000)
      this.waiting = {
        resolve: (r) => {
          clearTimeout(timer)
          resolve(r)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      }
    })
  }

  private feed(text: string): void {
    this.buffer += text
    for (;;) {
      const end = this.buffer.indexOf('\r\n')
      if (end < 0) return
      const line = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 2)
      const m = /^(\d{3})([ -])(.*)$/.exec(line)
      if (!m) continue
      this.partial.push(m[3]!)
      if (m[2] === ' ') {
        const reply: Reply = { code: Number(m[1]), lines: this.partial }
        this.partial = []
        const w = this.waiting
        if (w) {
          this.waiting = null
          w.resolve(reply)
        } else this.replies.push(reply)
      }
    }
  }

  private end(e: Error): void {
    if (this.closed) return
    this.closed = e
    const w = this.waiting
    this.waiting = null
    w?.reject(e)
    this.socket?.close()
  }
}
