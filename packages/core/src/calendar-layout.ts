// Laying out a calendar: the weeks of a month, the days of a week, and where meetings go in a column of hours. Shared by the
// desktop and the phone, which draw the results differently.

/** Where each meeting of one day goes in a column of hours: its minutes, and which lane when meetings overlap. */
export interface Placed<T> {
  o: T
  /** Minutes from the start of the day. */
  from: number
  to: number
  lane: number
  lanes: number
}

/** Lays one day's meetings side by side where they overlap, as calendars do. */
export function placeDay<T extends { start: number; end: number }>(items: T[], dayStart: number, dayEnd: number, minBlockMinutes = 25): Placed<T>[] {
  const clipped = items
    .map((o) => {
      const end = o.end > o.start ? o.end : o.start + 30 * 60_000
      return { o, from: (Math.max(o.start, dayStart) - dayStart) / 60_000, to: (Math.min(end, dayEnd) - dayStart) / 60_000 }
    })
    .filter((c) => c.to > c.from)
    .sort((a, b) => a.from - b.from || b.to - a.to)
  const out: Placed<T>[] = []
  let cluster: Placed<T>[] = []
  let laneEnds: number[] = []
  let clusterEnd = -1
  const flush = () => {
    for (const p of cluster) p.lanes = laneEnds.length
    out.push(...cluster)
    cluster = []
    laneEnds = []
  }
  for (const c of clipped) {
    if (cluster.length > 0 && c.from >= clusterEnd) flush()
    // A block shows at least this tall, so a short meeting still claims that much room.
    const shown = Math.max(c.to, c.from + minBlockMinutes)
    let lane = laneEnds.findIndex((end) => end <= c.from)
    if (lane === -1) lane = laneEnds.length
    laneEnds[lane] = shown
    cluster.push({ ...c, lane, lanes: 1 })
    clusterEnd = Math.max(clusterEnd, shown)
  }
  flush()
  return out
}

/** The weeks to draw for a month: always whole weeks (Sunday first), six at most, as local dates. */
export function monthGrid(year: number, month: number): Date[][] {
  const first = new Date(year, month, 1)
  const start = new Date(year, month, 1 - first.getDay())
  const weeks: Date[][] = []
  for (let w = 0; w < 6; w++) {
    const week = Array.from({ length: 7 }, (_, d) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + d))
    // Stop once a whole week falls after the month.
    if (w > 0 && week[0]!.getMonth() !== month && week[0]!.getTime() > first.getTime()) break
    weeks.push(week)
  }
  return weeks
}

/** Day key used to group meetings: "2026-11-04" in local time. */
export const dayKey = (ms: number | Date): string => {
  const d = typeof ms === 'number' ? new Date(ms) : ms
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}


/**
 * Groups meetings by each local day they touch, so a meeting that runs past midnight shows on both days. An all-day
 * meeting ends the day after it is shown to end (its end is exclusive). `allDay` says whether an item is one.
 */
export function groupByDayOf<T extends { start: number; end: number }>(items: T[], allDay: (item: T) => boolean): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const o of items) {
    const all = allDay(o)
    const last = new Date(all || o.end <= o.start ? o.start : o.end - 1)
    const lastKey = dayKey(all ? new Date(o.end - 1) : last)
    for (let d = new Date(new Date(o.start).setHours(0, 0, 0, 0)); dayKey(d) <= lastKey; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
      const k = dayKey(d)
      out.set(k, [...(out.get(k) ?? []), o])
    }
  }
  return out
}

/** The seven days of the week that holds `date`, Sunday first, as local dates at midnight. */
export function weekOf(date: Date): Date[] {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate() - date.getDay())
  return Array.from({ length: 7 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i))
}
