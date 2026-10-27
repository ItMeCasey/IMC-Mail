import { dayKey, groupByDayOf, monthGrid } from '@imc/core'

export { dayKey, monthGrid }

/** Groups meetings by each local day they touch (see groupByDayOf in core). */
export function groupByDay<T extends { start: number; end: number; event: { allDay: boolean } }>(items: T[]): Map<string, T[]> {
  return groupByDayOf(items, (o) => o.event.allDay)
}
