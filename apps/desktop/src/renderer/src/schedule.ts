export interface SchedulePreset {
  label: string
  /** Epoch ms. */
  at: number
}

const at = (base: Date, dayOffset: number, hour: number, minute = 0): Date => {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, hour, minute, 0, 0)
  return d
}

const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const dayName = new Intl.DateTimeFormat(undefined, { weekday: 'long' })

/**
 * "When should this go out?" shortcuts, relative to now: later today (only while it is still
 * ahead), tomorrow morning, and the next Monday if that is at least two days away.
 */
export function schedulePresets(now: Date): SchedulePreset[] {
  const out: SchedulePreset[] = []
  const evening = at(now, 0, 18)
  if (evening.getTime() - now.getTime() > 60 * 60 * 1000) {
    out.push({ label: `Later today, ${clock.format(evening)}`, at: evening.getTime() })
  }
  const tomorrow = at(now, 1, 8)
  out.push({ label: `Tomorrow, ${clock.format(tomorrow)}`, at: tomorrow.getTime() })
  const daysToMonday = (8 - now.getDay()) % 7 || 7
  if (daysToMonday >= 2) {
    const monday = at(now, daysToMonday, 8)
    out.push({ label: `${dayName.format(monday)}, ${clock.format(monday)}`, at: monday.getTime() })
  }
  return out
}

/** Value for an <input type="datetime-local">, in local time. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Epoch ms from a datetime-local value, or null if it is empty or invalid. */
export function fromLocalInput(v: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v)
  if (!m) return null
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime()
  return Number.isNaN(t) ? null : t
}

const full = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
export const describeTime = (ms: number): string => full.format(new Date(ms))

/** Snooze shortcuts: later today, tomorrow morning, the weekend, next week. Only offers what is far enough ahead. */
export function snoozePresets(now: Date): SchedulePreset[] {
  const out: SchedulePreset[] = []
  const evening = at(now, 0, 18)
  if (evening.getTime() - now.getTime() > 60 * 60 * 1000) {
    out.push({ label: `Later today, ${clock.format(evening)}`, at: evening.getTime() })
  }
  const tomorrow = at(now, 1, 8)
  out.push({ label: `Tomorrow, ${clock.format(tomorrow)}`, at: tomorrow.getTime() })
  const daysToSat = (6 - now.getDay() + 7) % 7
  if (daysToSat >= 2 && daysToSat <= 5) {
    const sat = at(now, daysToSat, 9)
    out.push({ label: `This weekend, ${dayName.format(sat)} ${clock.format(sat)}`, at: sat.getTime() })
  }
  const daysToMonday = (8 - now.getDay()) % 7 || 7
  if (daysToMonday >= 2) {
    const monday = at(now, daysToMonday, 8)
    out.push({ label: `Next week, ${dayName.format(monday)} ${clock.format(monday)}`, at: monday.getTime() })
  }
  return out
}

/** "Remind me if nobody replies" shortcuts: a few days to a couple of weeks out, at 9 in the morning. */
export function followUpPresets(now: Date): SchedulePreset[] {
  return [
    [2, 'In 2 days'],
    [3, 'In 3 days'],
    [7, 'In 1 week'],
    [14, 'In 2 weeks']
  ].map(([days, label]) => {
    const d = at(now, days as number, 9)
    return { label: `${label as string}, ${dayName.format(d)} ${clock.format(d)}`, at: d.getTime() }
  })
}
