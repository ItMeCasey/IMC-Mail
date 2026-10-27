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
