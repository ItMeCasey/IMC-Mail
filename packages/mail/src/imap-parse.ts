// Reading what an IMAP server says. A response is lines of text with "literals" (raw bytes announced as {n})
// in between. They are read into one piece of text with each literal replaced by a marker, which the parser
// below turns back into bytes.

const text = new TextDecoder()

export interface RawResponse {
  /** The response as text, each literal replaced by a marker (see `LIT`). */
  text: string
  literals: Uint8Array[]
}

const LIT_OPEN = '\u0000'
const marker = (i: number) => `${LIT_OPEN}${i}${LIT_OPEN}`
const LITERAL_AT_END = /\{(\d+)\+?\}$/

/** Collects bytes from the connection and cuts them into whole responses. */
export class ResponseReader {
  private buf = new Uint8Array(0)

  push(chunk: Uint8Array): void {
    const next = new Uint8Array(this.buf.length + chunk.length)
    next.set(this.buf)
    next.set(chunk, this.buf.length)
    this.buf = next
  }

  /** The next whole response, or null if the rest has not arrived yet. */
  next(): RawResponse | null {
    let pos = 0
    let out = ''
    const literals: Uint8Array[] = []
    for (;;) {
      const end = this.indexOfCrlf(pos)
      if (end < 0) return null
      const line = text.decode(this.buf.subarray(pos, end))
      const lit = LITERAL_AT_END.exec(line)
      if (!lit) {
        out += line
        this.buf = this.buf.slice(end + 2)
        return { text: out, literals }
      }
      const n = Number(lit[1])
      const start = end + 2
      if (this.buf.length < start + n) return null
      out += line.slice(0, line.length - lit[0].length) + marker(literals.length)
      literals.push(this.buf.slice(start, start + n))
      pos = start + n
    }
  }

  private indexOfCrlf(from: number): number {
    for (let i = from; i < this.buf.length - 1; i++) if (this.buf[i] === 13 && this.buf[i + 1] === 10) return i
    return -1
  }
}

/** A parsed value: an atom or string, NIL, raw bytes (a literal), or a list. */
export type Node = string | null | Uint8Array | Node[]

/** Parses a parenthesized list, an atom, a quoted string, NIL or a literal marker, starting at `from`. */
export function parseNode(src: string, literals: Uint8Array[], from = 0): { node: Node; end: number } {
  let i = from
  const skip = () => {
    while (src[i] === ' ') i++
  }
  skip()
  const c = src[i]
  if (c === undefined) throw new Error('Unexpected end of response')
  if (c === '(') {
    i++
    const list: Node[] = []
    for (;;) {
      skip()
      if (src[i] === ')') return { node: list, end: i + 1 }
      if (i >= src.length) throw new Error('Unclosed list in response')
      const r = parseNode(src, literals, i)
      list.push(r.node)
      i = r.end
    }
  }
  if (c === '"') {
    let s = ''
    i++
    while (i < src.length && src[i] !== '"') {
      if (src[i] === '\\') i++
      s += src[i]
      i++
    }
    return { node: s, end: i + 1 }
  }
  if (c === LIT_OPEN) {
    const close = src.indexOf(LIT_OPEN, i + 1)
    const lit = literals[Number(src.slice(i + 1, close))]
    if (!lit) throw new Error('A literal is missing from the response')
    return { node: lit, end: close + 1 }
  }
  // An atom runs to a space or a closing parenthesis, but may contain a [section] that has both inside.
  let s = ''
  while (i < src.length && src[i] !== ' ' && src[i] !== ')' && src[i] !== '(') {
    if (src[i] === '[') {
      const close = src.indexOf(']', i)
      if (close < 0) throw new Error('Unclosed section in response')
      s += src.slice(i, close + 1)
      i = close + 1
      continue
    }
    s += src[i]
    i++
  }
  return { node: s.toUpperCase() === 'NIL' ? null : s, end: i }
}

/** A list of alternating names and values, as in a FETCH response, as a map keyed by the upper-case name. */
export function pairs(list: Node[]): Map<string, Node> {
  const m = new Map<string, Node>()
  for (let i = 0; i + 1 < list.length; i += 2) {
    const k = list[i]
    if (typeof k === 'string') m.set(k.toUpperCase(), list[i + 1] ?? null)
  }
  return m
}

export const asText = (n: Node | undefined): string => (n instanceof Uint8Array ? text.decode(n) : typeof n === 'string' ? n : '')

// ---- folder names ---------------------------------------------------------------------------------------

/** IMAP folder names use a "modified UTF-7" (&AOk- is é). */
export function decodeMutf7(name: string): string {
  return name.replace(/&([^-]*)-/g, (_, b64: string) => {
    if (b64 === '') return '&'
    const std = b64.replace(/,/g, '/')
    const bin = atobSafe(std + '='.repeat((4 - (std.length % 4)) % 4))
    let out = ''
    for (let i = 0; i + 1 < bin.length; i += 2) out += String.fromCharCode((bin.charCodeAt(i) << 8) | bin.charCodeAt(i + 1))
    return out
  })
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function atobSafe(s: string): string {
  let out = ''
  let bits = 0
  let acc = 0
  for (const ch of s) {
    if (ch === '=') break
    acc = (acc << 6) | B64.indexOf(ch)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out += String.fromCharCode((acc >> bits) & 255)
    }
  }
  return out
}
