export interface Deadline {
  /** Local midnight of the day, epoch ms. */
  date: number
  /** The words it was found in, for showing the user where it came from. */
  phrase: string
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MONTH = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`
const CUE = String.raw`(?:by|before|due(?:\s+(?:on|by))?|deadline(?:\s+is)?|until|no\s+later\s+than|on\s+or\s+before|submit(?:ted)?\s+by|delivered?\s+by|live\s+by|go(?:es)?\s+live(?:\s+on)?)\s*[:\-]?\s*(?:the\s+)?`
const DAY = String.raw`(\d{1,2})(?:st|nd|rd|th)?`

const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate())

/** A month and day with no year means the next time that date comes round (a little past is still "this year"). */
function resolve(month: number, day: number, year: number | null, today: Date): Date | null {
  const y = year ?? today.getFullYear()
  const d = new Date(y, month, day)
  if (d.getMonth() !== month || d.getDate() !== day) return null // 31 Feb and the like
  if (year === null && d.getTime() < today.getTime() - 30 * 86_400_000) d.setFullYear(y + 1)
  return d
}

/**
 * Dates a sender asks for, found next to words like "by", "due" or "deadline". Conservative on
 * purpose: a date with no such cue ("we met on March 3") is not a deadline. Numeric dates are
 * read month first (US), and only when they follow a cue.
 */
export function findDeadlines(text: string, now: Date = new Date()): Deadline[] {
  const today = startOfDay(now)
  const out = new Map<number, Deadline>()
  const add = (d: Date | null, phrase: string) => {
    if (d && !out.has(d.getTime())) out.set(d.getTime(), { date: d.getTime(), phrase: phrase.trim().replace(/\s+/g, ' ') })
  }
  const flat = text.replace(/\s+/g, ' ')

  const monthIndex = (name: string) => MONTHS.indexOf(name.slice(0, 3).toLowerCase())
  const year = (y?: string) => (y ? (y.length === 2 ? 2000 + Number(y) : Number(y)) : null)

  // by November 15(th)(, 2026)
  for (const m of flat.matchAll(new RegExp(String.raw`${CUE}${MONTH}\s+${DAY}(?:\s*,?\s*(\d{4}))?\b`, 'gi'))) {
    add(resolve(monthIndex(m[1]!), Number(m[2]), year(m[3]), today), m[0])
  }
  // by 15(th) (of) November(, 2026)
  for (const m of flat.matchAll(new RegExp(String.raw`${CUE}${DAY}\s+(?:of\s+)?${MONTH}(?:\s*,?\s*(\d{4}))?\b`, 'gi'))) {
    add(resolve(monthIndex(m[2]!), Number(m[1]), year(m[3]), today), m[0])
  }
  // by 11/15 or 11/15/26 or 11/15/2026
  for (const m of flat.matchAll(new RegExp(String.raw`${CUE}(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?(?!\d)`, 'gi'))) {
    const mo = Number(m[1]) - 1
    if (mo >= 0 && mo <= 11) add(resolve(mo, Number(m[2]), year(m[3]), today), m[0])
  }
  // by Friday: the next one, not today
  for (const m of flat.matchAll(new RegExp(String.raw`${CUE}(?:end\s+of\s+(?:day\s+)?)?(${WEEKDAYS.join('|')})\b`, 'gi'))) {
    const want = WEEKDAYS.indexOf(m[1]!.toLowerCase())
    const d = new Date(today)
    d.setDate(d.getDate() + (((want - today.getDay() + 7) % 7) || 7))
    add(d, m[0])
  }
  // within 7 days / within 2 weeks
  for (const m of flat.matchAll(/\bwithin\s+(\d{1,3})\s+(day|week)s?\b/gi)) {
    const n = Number(m[1]) * (m[2]!.toLowerCase() === 'week' ? 7 : 1)
    const d = new Date(today)
    d.setDate(d.getDate() + n)
    add(d, m[0])
  }
  return [...out.values()].sort((a, b) => a.date - b.date)
}

/** The soonest deadline that has not passed, or null. */
export function nextDeadline(text: string, now: Date = new Date()): Deadline | null {
  const today = startOfDay(now).getTime()
  return findDeadlines(text, now).find((d) => d.date >= today) ?? null
}
