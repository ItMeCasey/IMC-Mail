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
 * Groups meetings by each local day they touch, so a meeting that runs past midnight shows on both
 * days. An all-day meeting ends the day after it is shown to end (its end is exclusive).
 */
export function groupByDay<T extends { start: number; end: number; event: { allDay: boolean } }>(items: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const o of items) {
    const last = new Date(o.event.allDay || o.end <= o.start ? o.start : o.end - 1)
    const lastKey = dayKey(o.event.allDay ? new Date(o.end - 1) : last)
    for (let d = new Date(new Date(o.start).setHours(0, 0, 0, 0)); dayKey(d) <= lastKey; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
      const k = dayKey(d)
      out.set(k, [...(out.get(k) ?? []), o])
    }
  }
  return out
}
