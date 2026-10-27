// A hybrid logical clock stamps every synced record. A stamp is a fixed-width string, so stamps sort
// correctly as plain strings: the wall clock in milliseconds, a counter for changes within the same
// millisecond (or when a device's clock is behind one it has heard from), and the device id to break ties.
// Two devices with clocks a few minutes apart still agree on which edit came last, because a device
// never stamps a record older than the newest stamp it has seen.

/** A stamp more than this far ahead of the local clock is refused, so one bad clock cannot win every conflict forever. */
export const MAX_CLOCK_DRIFT_MS = 24 * 60 * 60 * 1000

const HLC = /^(\d{15})-([0-9a-f]{4})-([A-Za-z0-9_]{1,32})$/

export interface Hlc {
  wall: number
  counter: number
  device: string
}

export const formatHlc = ({ wall, counter, device }: Hlc): string =>
  `${String(wall).padStart(15, '0')}-${counter.toString(16).padStart(4, '0')}-${device}`

export function parseHlc(stamp: string): Hlc | null {
  const m = HLC.exec(stamp)
  return m ? { wall: Number(m[1]), counter: parseInt(m[2]!, 16), device: m[3]! } : null
}

export const isHlc = (stamp: string): boolean => HLC.test(stamp)

/** -1, 0 or 1: which stamp is newer. */
export const compareHlc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** True when the stamp is well formed and not absurdly far in the future. */
export function isPlausibleHlc(stamp: string, now: number): boolean {
  const p = parseHlc(stamp)
  return p !== null && p.wall <= now + MAX_CLOCK_DRIFT_MS
}

const bump = (wall: number, counter: number, device: string): string =>
  // A counter that runs out moves on to the next millisecond.
  counter > 0xffff ? formatHlc({ wall: wall + 1, counter: 0, device }) : formatHlc({ wall, counter, device })

/** The stamp for a change made on this device now. `last` is the newest stamp this device has made or seen. */
export function tickHlc(last: string | null, now: number, device: string): string {
  const prev = last ? parseHlc(last) : null
  if (!prev || now > prev.wall) return formatHlc({ wall: now, counter: 0, device })
  return bump(prev.wall, prev.counter + 1, device)
}

/** The newest stamp this device has seen after a record from elsewhere arrives. Throws if the record's clock is too far ahead. */
export function receiveHlc(last: string | null, remote: string, now: number, device: string): string {
  const r = parseHlc(remote)
  if (!r || r.wall > now + MAX_CLOCK_DRIFT_MS) throw new Error('A record carries a clock that is too far ahead')
  const prev = last ? parseHlc(last) : null
  const wall = Math.max(now, r.wall, prev?.wall ?? 0)
  const counters = [prev && prev.wall === wall ? prev.counter : -1, r.wall === wall ? r.counter : -1]
  return bump(wall, Math.max(...counters) + 1, device)
}
