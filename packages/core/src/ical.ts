/**
 * iCalendar (RFC 5545) and iMIP (RFC 5546) for meeting mail, written to interoperate with
 * Outlook / Exchange / Microsoft 365 as well as Google and Apple calendars.
 *
 * Outlook specifics handled here:
 *  - Windows time-zone names ("Eastern Standard Time") as TZID, with or without a VTIMEZONE
 *  - folded lines and CRLF, quoted parameter values, "mailto:" in any case
 *  - Teams / Zoom / Meet join links found in X- properties or in the text
 *  - REQUEST / REPLY / CANCEL / PUBLISH, SEQUENCE updates, RECURRENCE-ID overrides, EXDATE
 *  - replies that Outlook will accept: same UID and SEQUENCE, ATTENDEE with PARTSTAT, METHOD:REPLY
 *  - all times we send are UTC ("...Z"), which Outlook shows in the reader's own time zone
 */
import { safeWebUrl } from './url'

export type PartStat = 'NEEDS-ACTION' | 'ACCEPTED' | 'DECLINED' | 'TENTATIVE' | 'DELEGATED'

export interface CalPerson {
  name: string
  email: string
}

export interface CalAttendee extends CalPerson {
  partstat: PartStat | string
  role: string
  rsvp: boolean
}

export type CalStatus = 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED'

export interface CalEvent {
  /** METHOD of the enclosing calendar: REQUEST, REPLY, CANCEL, PUBLISH, ... */
  method: string | null
  uid: string
  sequence: number
  /** Set on an override of one occurrence of a repeating event (epoch ms of the original start). */
  recurrenceId: number | null
  summary: string
  description: string
  location: string
  /** Epoch ms (UTC). For all-day events, local midnight of the first day. */
  start: number
  end: number
  allDay: boolean
  rrule: string | null
  exdates: number[]
  organizer: CalPerson | null
  attendees: CalAttendee[]
  status: CalStatus
  /** A Teams / Zoom / Meet join link, if one can be found. */
  onlineUrl: string | null
  dtstamp: number | null
  /** TRANSP:TRANSPARENT (shows as free). */
  free: boolean
}

// ---- time zones ----------------------------------------------------------------------

/** Windows zone names Outlook writes, mapped to IANA names the platform understands. */
export const WINDOWS_ZONES: Record<string, string> = {
  'dateline standard time': 'Etc/GMT+12',
  'hawaiian standard time': 'Pacific/Honolulu',
  'alaskan standard time': 'America/Anchorage',
  'pacific standard time': 'America/Los_Angeles',
  'pacific standard time (mexico)': 'America/Tijuana',
  'us mountain standard time': 'America/Phoenix',
  'mountain standard time': 'America/Denver',
  'central standard time': 'America/Chicago',
  'central america standard time': 'America/Guatemala',
  'canada central standard time': 'America/Regina',
  'central standard time (mexico)': 'America/Mexico_City',
  'mexico standard time': 'America/Mexico_City',
  'eastern standard time': 'America/New_York',
  'us eastern standard time': 'America/Indiana/Indianapolis',
  'sa pacific standard time': 'America/Bogota',
  'atlantic standard time': 'America/Halifax',
  'newfoundland standard time': 'America/St_Johns',
  'sa eastern standard time': 'America/Cayenne',
  'e. south america standard time': 'America/Sao_Paulo',
  'argentina standard time': 'America/Argentina/Buenos_Aires',
  'greenland standard time': 'America/Nuuk',
  'utc': 'UTC',
  'gmt standard time': 'Europe/London',
  'greenwich standard time': 'Atlantic/Reykjavik',
  'w. europe standard time': 'Europe/Berlin',
  'central europe standard time': 'Europe/Budapest',
  'central european standard time': 'Europe/Warsaw',
  'romance standard time': 'Europe/Paris',
  'e. europe standard time': 'Europe/Chisinau',
  'fle standard time': 'Europe/Kiev',
  'gtb standard time': 'Europe/Bucharest',
  'turkey standard time': 'Europe/Istanbul',
  'russian standard time': 'Europe/Moscow',
  'south africa standard time': 'Africa/Johannesburg',
  'egypt standard time': 'Africa/Cairo',
  'israel standard time': 'Asia/Jerusalem',
  'arab standard time': 'Asia/Riyadh',
  'arabian standard time': 'Asia/Dubai',
  'iran standard time': 'Asia/Tehran',
  'pakistan standard time': 'Asia/Karachi',
  'india standard time': 'Asia/Kolkata',
  'bangladesh standard time': 'Asia/Dhaka',
  'se asia standard time': 'Asia/Bangkok',
  'china standard time': 'Asia/Shanghai',
  'singapore standard time': 'Asia/Singapore',
  'taipei standard time': 'Asia/Taipei',
  'w. australia standard time': 'Australia/Perth',
  'tokyo standard time': 'Asia/Tokyo',
  'korea standard time': 'Asia/Seoul',
  'cen. australia standard time': 'Australia/Adelaide',
  'aus central standard time': 'Australia/Darwin',
  'e. australia standard time': 'Australia/Brisbane',
  'aus eastern standard time': 'Australia/Sydney',
  'tasmania standard time': 'Australia/Hobart',
  'new zealand standard time': 'Pacific/Auckland'
}

const zoneCache = new Map<string, boolean>()
function validZone(tz: string): boolean {
  let ok = zoneCache.get(tz)
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz })
      ok = true
    } catch {
      ok = false
    }
    zoneCache.set(tz, ok)
  }
  return ok
}

/** A TZID as an IANA name, or null if we do not know it. Handles Outlook's Windows names. */
export function resolveZone(tzid: string): string | null {
  const t = tzid.trim().replace(/^"|"$/g, '')
  const win = WINDOWS_ZONES[t.toLowerCase()]
  if (win && validZone(win)) return win
  if (validZone(t)) return t
  // Some clients prefix a Microsoft path: "/mozilla.org/20050126_1/Europe/Paris".
  const tail = t.split('/').slice(-2).join('/')
  if (tail && validZone(tail)) return tail
  return null
}

function offsetMinutes(ms: number, tz: string): number {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
  const p: Record<string, number> = {}
  for (const part of f.formatToParts(new Date(ms))) if (part.type !== 'literal') p[part.type] = Number(part.value)
  const asUtc = Date.UTC(p['year']!, p['month']! - 1, p['day']!, p['hour']!, p['minute']!, p['second']!)
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000)
}

/** Wall-clock time in a zone to an absolute instant, correct across daylight-saving changes. */
export function zonedToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  tz: string
): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s)
  const o1 = offsetMinutes(guess, tz)
  let t = guess - o1 * 60000
  const o2 = offsetMinutes(t, tz)
  if (o2 !== o1) t = guess - o2 * 60000
  return t
}

// ---- parsing -------------------------------------------------------------------------

interface Prop {
  name: string
  params: Record<string, string>
  value: string
}

/** RFC 5545 line unfolding: a line starting with a space or tab continues the previous one. */
export const unfold = (text: string): string => text.replace(/\r?\n[ \t]/g, '')

function parseLine(line: string): Prop | null {
  let inQuote = false
  let colon = -1
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') inQuote = !inQuote
    else if (c === ':' && !inQuote) {
      colon = i
      break
    }
  }
  if (colon < 1) return null
  const head = line.slice(0, colon)
  const value = line.slice(colon + 1)
  const parts: string[] = []
  let cur = ''
  inQuote = false
  for (const c of head) {
    if (c === '"') inQuote = !inQuote
    if (c === ';' && !inQuote) {
      parts.push(cur)
      cur = ''
    } else cur += c
  }
  parts.push(cur)
  const params: Record<string, string> = {}
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=')
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '')
  }
  return { name: parts[0]!.toUpperCase(), params, value }
}

const unescapeText = (v: string): string =>
  v.replace(/\\([nN,;\\])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c))

function person(p: Prop): CalPerson {
  const email = p.value.replace(/^mailto:/i, '').trim().toLowerCase()
  return { name: (p.params['CN'] ?? '').trim(), email }
}

const DATE_TIME = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/i

/** An iCalendar date or date-time property as epoch ms. `fixed` holds offsets from VTIMEZONEs. */
function parseTime(p: Prop, fixed: Map<string, number>): { ms: number; allDay: boolean } | null {
  const m = DATE_TIME.exec(p.value.trim())
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const dateOnly = m[4] === undefined || p.params['VALUE'] === 'DATE'
  const [h, mi, s] = [Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)]
  if (dateOnly) return { ms: new Date(y, mo - 1, d).getTime(), allDay: true }
  if (m[7]) return { ms: Date.UTC(y, mo - 1, d, h, mi, s), allDay: false }
  const tzid = p.params['TZID']
  if (tzid) {
    const zone = resolveZone(tzid)
    if (zone) return { ms: zonedToUtc(y, mo, d, h, mi, s, zone), allDay: false }
    const off = fixed.get(tzid)
    if (off !== undefined) return { ms: Date.UTC(y, mo - 1, d, h, mi, s) - off * 60000, allDay: false }
  }
  // Floating time: the reader's own zone.
  return { ms: new Date(y, mo - 1, d, h, mi, s).getTime(), allDay: false }
}

function parseDuration(v: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(v.trim())
  if (!m) return null
  const n = (x: string | undefined) => Number(x ?? 0)
  const ms = (((n(m[2]) * 7 + n(m[3])) * 24 + n(m[4])) * 60 + n(m[5])) * 60_000 + n(m[6]) * 1000
  return m[1] === '-' ? -ms : ms
}

const JOIN_LINK =
  /https?:\/\/(?:teams\.microsoft\.com\/l\/meetup-join\/[^\s<>"')\]]+|[\w.-]*zoom\.us\/j\/[^\s<>"')\]]+|meet\.google\.com\/[a-z-]+|[\w.-]*webex\.com\/[^\s<>"')\]]*(?:meet|join)[^\s<>"')\]]*|teams\.live\.com\/meet\/[^\s<>"')\]]+)/i

export function findJoinLink(...texts: string[]): string | null {
  for (const t of texts) {
    const m = JOIN_LINK.exec(t)
    const link = m ? safeWebUrl(m[0].replace(/[.,;]+$/, '')) : null
    if (link) return link
  }
  return null
}

/** Every VEVENT in an iCalendar document. Never throws on malformed input. */
export function parseICS(text: string): CalEvent[] {
  const lines = unfold(text).split(/\r?\n/)
  const fixed = new Map<string, number>()
  const out: CalEvent[] = []
  let method: string | null = null

  // Pass 1: offsets declared by VTIMEZONEs, used only when a TZID is not a name we know.
  let tz: { id: string; off: number | null } | null = null
  let inStandard = false
  for (const raw of lines) {
    const p = parseLine(raw)
    if (!p) continue
    if (p.name === 'BEGIN' && p.value.toUpperCase() === 'VTIMEZONE') tz = { id: '', off: null }
    else if (p.name === 'END' && p.value.toUpperCase() === 'VTIMEZONE') {
      if (tz?.id && tz.off !== null) fixed.set(tz.id, tz.off)
      tz = null
    } else if (tz) {
      if (p.name === 'TZID') tz.id = p.value.trim()
      else if (p.name === 'BEGIN') inStandard = p.value.toUpperCase() === 'STANDARD'
      else if (p.name === 'TZOFFSETTO' && (inStandard || tz.off === null)) {
        const m = /^([+-])(\d{2})(\d{2})/.exec(p.value.trim())
        if (m) tz.off = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
      }
    }
  }

  // Pass 2: the events.
  let cur: Prop[] | null = null
  let depth = 0
  for (const raw of lines) {
    const p = parseLine(raw)
    if (!p) continue
    if (p.name === 'METHOD' && !cur) method = p.value.trim().toUpperCase()
    if (p.name === 'BEGIN') {
      if (p.value.toUpperCase() === 'VEVENT' && !cur) {
        cur = []
        depth = 0
      } else if (cur) depth++ // a VALARM inside the event
      continue
    }
    if (p.name === 'END') {
      if (p.value.toUpperCase() === 'VEVENT' && cur && depth === 0) {
        const ev = buildEvent(cur, method, fixed)
        if (ev) out.push(ev)
        cur = null
      } else if (cur) depth--
      continue
    }
    if (cur && depth === 0) cur.push(p)
  }
  return out
}

function buildEvent(props: Prop[], method: string | null, fixed: Map<string, number>): CalEvent | null {
  const first = (n: string) => props.find((p) => p.name === n)
  const all = (n: string) => props.filter((p) => p.name === n)
  const uid = first('UID')?.value.trim()
  const dtstart = first('DTSTART')
  if (!uid || !dtstart) return null
  const start = parseTime(dtstart, fixed)
  if (!start) return null

  let end = start.ms
  const dtend = first('DTEND')
  const dur = first('DURATION')
  const parsedEnd = dtend ? parseTime(dtend, fixed) : null
  if (parsedEnd) end = parsedEnd.ms
  else if (dur) end = start.ms + (parseDuration(dur.value) ?? 0)
  else if (start.allDay) end = start.ms + 24 * 3600 * 1000

  const description = unescapeText(first('DESCRIPTION')?.value ?? '')
  const location = unescapeText(first('LOCATION')?.value ?? '')
  const url =
    first('X-MICROSOFT-SKYPETEAMSMEETINGURL')?.value.trim() ||
    first('X-MICROSOFT-ONLINEMEETINGEXTERNALLINK')?.value.trim() ||
    first('X-GOOGLE-CONFERENCE')?.value.trim() ||
    first('URL')?.value.trim() ||
    null

  const status = (first('STATUS')?.value.trim().toUpperCase() ?? 'CONFIRMED') as CalStatus
  const org = first('ORGANIZER')
  const rid = first('RECURRENCE-ID')
  const stamp = first('DTSTAMP')

  return {
    method,
    uid,
    sequence: Number(first('SEQUENCE')?.value.trim() ?? 0) || 0,
    recurrenceId: rid ? (parseTime(rid, fixed)?.ms ?? null) : null,
    summary: unescapeText(first('SUMMARY')?.value ?? '').trim(),
    description,
    location,
    start: start.ms,
    end,
    allDay: start.allDay,
    rrule: first('RRULE')?.value.trim() ?? null,
    exdates: all('EXDATE').flatMap((p) =>
      p.value.split(',').flatMap((v) => {
        const t = parseTime({ ...p, value: v }, fixed)
        return t ? [t.ms] : []
      })
    ),
    organizer: org ? person(org) : null,
    attendees: all('ATTENDEE').map((a) => ({
      ...person(a),
      partstat: (a.params['PARTSTAT'] ?? 'NEEDS-ACTION').toUpperCase(),
      role: (a.params['ROLE'] ?? 'REQ-PARTICIPANT').toUpperCase(),
      rsvp: (a.params['RSVP'] ?? '').toUpperCase() === 'TRUE'
    })),
    status: status === 'CANCELLED' || status === 'TENTATIVE' ? status : 'CONFIRMED',
    onlineUrl: safeWebUrl(url) ?? findJoinLink(location, description),
    dtstamp: stamp ? (parseTime(stamp, fixed)?.ms ?? null) : null,
    free: first('TRANSP')?.value.trim().toUpperCase() === 'TRANSPARENT'
  }
}

// ---- recurrence ----------------------------------------------------------------------

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

interface Rule {
  freq: string
  interval: number
  count: number | null
  until: number | null
  byday: { n: number; day: number }[]
  bymonthday: number[]
  bymonth: number[]
}

function parseRule(rrule: string, fixed = new Map<string, number>()): Rule | null {
  const kv = Object.fromEntries(
    rrule.split(';').flatMap((p) => {
      const i = p.indexOf('=')
      return i > 0 ? [[p.slice(0, i).toUpperCase(), p.slice(i + 1)] as const] : []
    })
  )
  const freq = kv['FREQ']?.toUpperCase()
  if (!freq || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return null
  const until = kv['UNTIL'] ? (parseTime({ name: 'UNTIL', params: {}, value: kv['UNTIL'] }, fixed)?.ms ?? null) : null
  return {
    freq,
    interval: Math.max(1, Number(kv['INTERVAL'] ?? 1) || 1),
    count: kv['COUNT'] ? Number(kv['COUNT']) : null,
    until: until === null ? null : until + (kv['UNTIL']!.length === 8 ? 24 * 3600 * 1000 - 1 : 0),
    byday: (kv['BYDAY'] ?? '')
      .split(',')
      .flatMap((d) => {
        const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(d.trim())
        return m ? [{ n: Number(m[1] ?? 0), day: DAYS.indexOf(m[2]!.toUpperCase()) }] : []
      }),
    bymonthday: (kv['BYMONTHDAY'] ?? '').split(',').filter(Boolean).map(Number),
    bymonth: (kv['BYMONTH'] ?? '').split(',').filter(Boolean).map(Number)
  }
}

/** "Every week on Monday, Wednesday" for display. Falls back to a neutral phrase. */
export function describeRecurrence(rrule: string | null): string | null {
  if (!rrule) return null
  const r = parseRule(rrule)
  if (!r) return 'Repeats'
  const every = (unit: string, plural: string) => (r.interval === 1 ? `Every ${unit}` : `Every ${r.interval} ${plural}`)
  let s: string
  if (r.freq === 'DAILY') s = every('day', 'days')
  else if (r.freq === 'WEEKLY') {
    s = every('week', 'weeks')
    if (r.byday.length) s += ` on ${r.byday.map((d) => DAY_NAMES[d.day]).join(', ')}`
  } else if (r.freq === 'MONTHLY') {
    s = every('month', 'months')
    if (r.bymonthday.length) s += ` on day ${r.bymonthday.join(', ')}`
    else if (r.byday.length) {
      const d = r.byday[0]!
      const ord = d.n === -1 ? 'last' : ['', 'first', 'second', 'third', 'fourth', 'fifth'][d.n] || ''
      s += ` on the ${ord} ${DAY_NAMES[d.day]}`.replace('  ', ' ')
    }
  } else s = every('year', 'years')
  if (r.count) s += `, ${r.count} times`
  else if (r.until) s += `, until ${new Date(r.until).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
  return s
}

const addDays = (ms: number, n: number) => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds()).getTime()
}

/**
 * Start times of a repeating event inside [from, to), at most `limit`. Handles DAILY, WEEKLY
 * (with BYDAY), MONTHLY (day of month, or nth weekday) and YEARLY, with COUNT, UNTIL, INTERVAL
 * and EXDATE. Wall-clock time is kept across daylight-saving changes, as calendars do.
 */
export function occurrences(ev: CalEvent, from: number, to: number, limit = 200): number[] {
  const r = ev.rrule ? parseRule(ev.rrule) : null
  const ex = new Set(ev.exdates)
  const hit = (t: number) => t + (ev.end - ev.start) > from && t < to && !ex.has(t)
  if (!r) return hit(ev.start) ? [ev.start] : []

  const out: number[] = []
  const s = new Date(ev.start)
  let produced = 0
  const push = (t: number): boolean => {
    if (t < ev.start) return true
    if (r.until !== null && t > r.until) return false
    produced++
    if (r.count !== null && produced > r.count) return false
    if (hit(t)) out.push(t)
    return out.length < limit && t < to
  }
  const at = (y: number, m: number, d: number) => new Date(y, m, d, s.getHours(), s.getMinutes(), s.getSeconds()).getTime()

  const guard = 5000
  if (r.freq === 'DAILY') {
    for (let i = 0, t = ev.start; i < guard; i++, t = addDays(ev.start, i * r.interval)) if (!push(t)) break
  } else if (r.freq === 'WEEKLY') {
    const days = r.byday.length ? r.byday.map((d) => d.day) : [s.getDay()]
    const weekStart = addDays(ev.start, -s.getDay())
    outer: for (let w = 0; w < guard; w++) {
      for (const dow of [...days].sort((a, b) => a - b)) {
        if (!push(addDays(weekStart, w * 7 * r.interval + dow))) break outer
      }
    }
  } else if (r.freq === 'MONTHLY') {
    outer2: for (let i = 0; i < guard; i++) {
      const base = new Date(s.getFullYear(), s.getMonth() + i * r.interval, 1)
      const dates: number[] = []
      if (r.byday.length && !r.bymonthday.length) {
        for (const { n, day } of r.byday) {
          const dim = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate()
          const matches = Array.from({ length: dim }, (_, k) => k + 1).filter((d) => new Date(base.getFullYear(), base.getMonth(), d).getDay() === day)
          const d = n > 0 ? matches[n - 1] : n < 0 ? matches[matches.length + n] : matches[0]
          if (d) dates.push(at(base.getFullYear(), base.getMonth(), d))
        }
      } else {
        for (const d of r.bymonthday.length ? r.bymonthday : [s.getDate()]) {
          const dim = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate()
          const day = d < 0 ? dim + d + 1 : d
          if (day >= 1 && day <= dim) dates.push(at(base.getFullYear(), base.getMonth(), day))
        }
      }
      for (const t of dates.sort((a, b) => a - b)) if (!push(t)) break outer2
    }
  } else {
    for (let i = 0; i < 200; i++) {
      if (!push(at(s.getFullYear() + i * r.interval, s.getMonth(), s.getDate()))) break
    }
  }
  return out
}

// ---- writing -------------------------------------------------------------------------

/** Escapes TEXT values (RFC 5545 3.3.11). */
export const escapeText = (v: string): string =>
  v.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')

/** Folds a content line to 75 octets, continuing with a space, never splitting a character. */
export function foldLine(line: string): string {
  const enc = new TextEncoder()
  if (enc.encode(line).length <= 75) return line
  const out: string[] = []
  let cur = ''
  let bytes = 0
  let limit = 75
  for (const ch of line) {
    const n = enc.encode(ch).length
    if (bytes + n > limit) {
      out.push(cur)
      cur = ''
      bytes = 0
      limit = 74 // the leading space counts
    }
    cur += ch
    bytes += n
  }
  out.push(cur)
  return out.join('\r\n ')
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** 20261030T140000Z */
export const icsUtc = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
}
/** 20261030 (local date, for all-day events) */
export const icsDate = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

/** One line of an iCalendar file can never hold a line break: a pasted one would start a new property. */
const oneLine = (v: string) => v.replace(/[\u0000-\u001f\u007f]+/g, ' ')
const quoteParam = (v: string) => {
  const s = oneLine(v)
  return /[;:,]/.test(s) ? `"${s.replace(/"/g, "'")}"` : s
}
const mailto = (email: string) => `mailto:${email}`

export interface IcsAttendee {
  name?: string
  email: string
  partstat?: string
  role?: string
  rsvp?: boolean
}

export interface IcsEvent {
  uid: string
  sequence: number
  summary: string
  description?: string
  location?: string
  start: number
  end: number
  allDay?: boolean
  organizer: CalPerson
  attendees: IcsAttendee[]
  status?: CalStatus
  onlineUrl?: string | null
  rrule?: string | null
  recurrenceId?: number | null
  /**
   * IANA zone the meeting is kept in. Given with an rrule, times are written as local time in that
   * zone with a VTIMEZONE, so the series keeps its wall-clock hour across daylight-saving changes.
   */
  zone?: string
  /** Optional free text for a REPLY, shown by Outlook with the response. */
  comment?: string
}

export type IcsMethod = 'REQUEST' | 'REPLY' | 'CANCEL' | 'PUBLISH'

export const PRODID = '-//IMC-Mail//Calendar 1.0//EN'

const pad2 = (n: number) => String(n).padStart(2, '0')

/** Offset of an IANA zone from UTC at an instant, in minutes (east positive). */
export function zoneOffsetMinutes(zone: string, at: number): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(at))
    .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT'
  const m = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(name)
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0
}

const localStamp = (utcMs: number, offsetMin: number): string => {
  const d = new Date(utcMs + offsetMin * 60_000)
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`
}
const offsetText = (min: number): string => `${min < 0 ? '-' : '+'}${pad2(Math.floor(Math.abs(min) / 60))}${pad2(Math.abs(min) % 60)}`

/** The name Outlook uses for a zone ("Eastern Standard Time"), or the IANA name if there is none. */
export function tzidFor(zone: string): string {
  const key = Object.keys(WINDOWS_ZONES).find((k) => WINDOWS_ZONES[k] === zone)
  if (!key) return zone
  return key
    .split(' ')
    .map((w) => (w === 'us' || w === 'utc' ? w.toUpperCase() : w.replace(/^\(?[a-z]/, (c) => c.toUpperCase())))
    .join(' ')
}

/**
 * A VTIMEZONE for `zone` covering the year of `around` and the three after it, with each daylight
 * change written out as its own dated component (valid, and needs no recurrence-rule guesswork).
 */
export function vtimezone(zone: string, tzid: string, around: number): string[] {
  const year = new Date(around).getUTCFullYear()
  const start = Date.UTC(year, 0, 1)
  const end = Date.UTC(year + 4, 0, 1)
  const DAY = 86_400_000
  const base = zoneOffsetMinutes(zone, start)
  const lines = ['BEGIN:VTIMEZONE', `TZID:${tzid}`, 'BEGIN:STANDARD', 'DTSTART:16010101T000000', `TZOFFSETFROM:${offsetText(base)}`, `TZOFFSETTO:${offsetText(base)}`, 'END:STANDARD']
  let prev = base
  for (let t = start + DAY; t <= end; t += DAY) {
    const off = zoneOffsetMinutes(zone, t)
    if (off === prev) continue
    let lo = t - DAY
    let hi = t
    while (hi - lo > 60_000) {
      const mid = Math.floor((lo + hi) / 2 / 60_000) * 60_000
      if (mid <= lo) break
      if (zoneOffsetMinutes(zone, mid) === prev) lo = mid
      else hi = mid
    }
    const kind = off > prev ? 'DAYLIGHT' : 'STANDARD'
    lines.push(`BEGIN:${kind}`, `DTSTART:${localStamp(hi, prev)}`, `TZOFFSETFROM:${offsetText(prev)}`, `TZOFFSETTO:${offsetText(off)}`, `END:${kind}`)
    prev = off
  }
  lines.push('END:VTIMEZONE')
  return lines
}

/** A complete iCalendar document, CRLF-terminated, ready for a text/calendar part. */
export function buildICS(method: IcsMethod, ev: IcsEvent, now = Date.now()): string {
  const lines: string[] = ['BEGIN:VCALENDAR', 'PRODID:' + PRODID, 'VERSION:2.0', 'CALSCALE:GREGORIAN', `METHOD:${method}`, 'BEGIN:VEVENT']
  const add = (l: string) => lines.push(oneLine(l))
  const zoned = !!(ev.zone && ev.rrule && !ev.allDay)
  const tzid = zoned ? tzidFor(ev.zone!) : ''
  if (zoned) lines.splice(lines.indexOf('BEGIN:VEVENT'), 0, ...vtimezone(ev.zone!, tzid, ev.start))
  add(`UID:${ev.uid}`)
  add(`DTSTAMP:${icsUtc(now)}`)
  add(`SEQUENCE:${ev.sequence}`)
  if (ev.recurrenceId) add(`RECURRENCE-ID:${icsUtc(ev.recurrenceId)}`)
  if (ev.allDay) {
    add(`DTSTART;VALUE=DATE:${icsDate(ev.start)}`)
    add(`DTEND;VALUE=DATE:${icsDate(ev.end)}`)
  } else if (zoned) {
    add(`DTSTART;TZID=${quoteParam(tzid)}:${localStamp(ev.start, zoneOffsetMinutes(ev.zone!, ev.start))}`)
    add(`DTEND;TZID=${quoteParam(tzid)}:${localStamp(ev.end, zoneOffsetMinutes(ev.zone!, ev.end))}`)
  } else {
    add(`DTSTART:${icsUtc(ev.start)}`)
    add(`DTEND:${icsUtc(ev.end)}`)
  }
  if (ev.rrule && method !== 'REPLY') add(`RRULE:${ev.rrule}`)
  add(`SUMMARY:${escapeText(ev.summary)}`)
  if (ev.location) add(`LOCATION:${escapeText(ev.location)}`)
  if (ev.description && method !== 'REPLY') add(`DESCRIPTION:${escapeText(ev.description)}`)
  if (ev.onlineUrl && method !== 'REPLY') {
    add(`URL:${ev.onlineUrl}`)
    add(`X-MICROSOFT-SKYPETEAMSMEETINGURL:${ev.onlineUrl}`)
  }
  const org = ev.organizer
  add(`ORGANIZER${org.name ? `;CN=${quoteParam(org.name)}` : ''}:${mailto(org.email)}`)
  for (const a of ev.attendees) {
    const rsvp = a.rsvp ?? method === 'REQUEST'
    const params = [
      `CUTYPE=INDIVIDUAL`,
      `ROLE=${a.role ?? 'REQ-PARTICIPANT'}`,
      `PARTSTAT=${a.partstat ?? (method === 'REQUEST' ? 'NEEDS-ACTION' : 'ACCEPTED')}`,
      `RSVP=${rsvp ? 'TRUE' : 'FALSE'}`,
      ...(a.name ? [`CN=${quoteParam(a.name)}`] : [])
    ]
    add(`ATTENDEE;${params.join(';')}:${mailto(a.email)}`)
  }
  if (ev.comment && method === 'REPLY') add(`COMMENT:${escapeText(ev.comment)}`)
  add(`STATUS:${method === 'CANCEL' ? 'CANCELLED' : (ev.status ?? 'CONFIRMED')}`)
  add('TRANSP:OPAQUE')
  // Outlook uses these to decide how the item shows on the calendar.
  add('X-MICROSOFT-CDO-BUSYSTATUS:BUSY')
  add('X-MICROSOFT-CDO-INTENDEDSTATUS:BUSY')
  if (ev.allDay) add('X-MICROSOFT-CDO-ALLDAYEVENT:TRUE')
  lines.push('END:VEVENT', 'END:VCALENDAR')
  return lines.map(foldLine).join('\r\n') + '\r\n'
}

export type ReplyStatus = 'ACCEPTED' | 'TENTATIVE' | 'DECLINED'

/**
 * The reply an organizer's Outlook (or any calendar) understands: same UID and SEQUENCE as the
 * request, and a single ATTENDEE line for the person replying carrying PARTSTAT.
 */
export function buildReply(
  request: CalEvent,
  me: CalPerson,
  response: ReplyStatus,
  comment?: string,
  now = Date.now()
): string {
  if (!request.organizer) throw new Error('This invitation does not say who organized it')
  return buildICS(
    'REPLY',
    {
      uid: request.uid,
      sequence: request.sequence,
      summary: request.summary,
      location: request.location,
      start: request.start,
      end: request.end,
      allDay: request.allDay,
      recurrenceId: request.recurrenceId,
      organizer: request.organizer,
      attendees: [{ name: me.name, email: me.email, partstat: response, rsvp: false }],
      comment
    },
    now
  )
}

/** Subject lines Outlook itself uses for replies, so threads and rules behave as people expect. */
export const replySubject = (response: ReplyStatus, summary: string): string =>
  `${response === 'ACCEPTED' ? 'Accepted' : response === 'TENTATIVE' ? 'Tentative' : 'Declined'}: ${summary}`
