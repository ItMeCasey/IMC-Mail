import { deflateSync } from 'node:zlib'

// 3x5 digits, one bit per pixel, top row first.
const DIGITS: Record<string, number[]> = {
  '0': [7, 5, 5, 5, 7],
  '1': [2, 6, 2, 2, 7],
  '2': [7, 1, 7, 4, 7],
  '3': [7, 1, 7, 1, 7],
  '4': [5, 5, 7, 1, 1],
  '5': [7, 4, 7, 1, 7],
  '6': [7, 4, 7, 5, 7],
  '7': [7, 1, 1, 1, 1],
  '8': [7, 5, 7, 5, 7],
  '9': [7, 5, 7, 1, 7]
}

const SIZE = 32

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf: Buffer): number => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type: string, data: Buffer): Buffer => {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const out = Buffer.alloc(body.length + 8)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), body.length + 4)
  return out
}

/** The text on the badge: the count, capped so it stays legible at taskbar size. */
export const badgeLabel = (n: number): string => (n > 99 ? '99' : String(Math.max(0, Math.floor(n))))

/** A round badge with the unread count in white, as a 32x32 PNG for the Windows taskbar overlay. */
export function badgePng(count: number, fill: [number, number, number] = [91, 107, 255]): Buffer {
  const label = badgeLabel(count)
  const px = Buffer.alloc(SIZE * SIZE * 4)
  const c = (SIZE - 1) / 2
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const d = Math.hypot(x - c, y - c)
      const a = Math.max(0, Math.min(1, c + 1 - d)) // soft edge
      const i = (y * SIZE + x) * 4
      px[i] = fill[0]
      px[i + 1] = fill[1]
      px[i + 2] = fill[2]
      px[i + 3] = Math.round(a * 255)
    }
  }
  // Two digits get scale 4, one digit scale 6, centred.
  const scale = label.length > 1 ? 4 : 6
  const gap = scale
  const width = label.length * 3 * scale + (label.length - 1) * gap
  const x0 = Math.round((SIZE - width) / 2)
  const y0 = Math.round((SIZE - 5 * scale) / 2)
  ;[...label].forEach((ch, k) => {
    DIGITS[ch]!.forEach((bits, row) => {
      for (let col = 0; col < 3; col++) {
        if (!(bits & (4 >> col))) continue
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const x = x0 + k * (3 * scale + gap) + col * scale + dx
            const y = y0 + row * scale + dy
            const i = (y * SIZE + x) * 4
            px[i] = px[i + 1] = px[i + 2] = px[i + 3] = 255
          }
        }
      }
    })
  })
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE)
  for (let y = 0; y < SIZE; y++) px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(SIZE, 0)
  ihdr.writeUInt32BE(SIZE, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/**
 * Keeps the taskbar or dock badge equal to the unread count in the inboxes. Nothing is shown
 * while stream-safe mode is hiding mail, because a count is still a fact about your mail.
 */
export class BadgeController {
  private last: number | null = null
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    private deps: {
      count: () => number
      hidden: () => boolean
      apply: (n: number) => void
    }
  ) {}

  refresh(): void {
    const n = this.deps.hidden() ? 0 : this.deps.count()
    if (n === this.last) return
    this.last = n
    this.deps.apply(n)
  }

  /** Forget what was applied, so the next refresh paints again (a new window has no overlay). */
  reset(): void {
    this.last = null
    this.refresh()
  }

  start(everyMs = 5000): void {
    this.refresh()
    this.timer = setInterval(() => this.refresh(), everyMs)
  }

  stop(): void {
    clearInterval(this.timer)
  }
}
