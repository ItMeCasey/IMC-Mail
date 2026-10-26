/**
 * Reading your own calendar from Microsoft (Graph) and Google (Calendar API). Both services
 * expand repeating meetings into single occurrences when asked, so everything here is one flat
 * list of events with a start and an end. This file only builds the requests and reads the
 * answers; the network calls live in the main process.
 */
import type { CalendarResponse } from './schemas'
import { findJoinLink } from './ical'
import { safeWebUrl } from './url'

export interface RemoteEvent {
  /** Unique for this occurrence in this calendar. */
  remoteId: string
  /** The iCalendar UID, shared with the invitation email when there was one. */
  uid: string
  summary: string
  description: string
  location: string
  start: number
  end: number
  allDay: boolean
  status: 'CONFIRMED' | 'TENTATIVE'
  onlineUrl: string | null
  organizer: { name: string; email: string } | null
  attendees: { name: string; email: string; partstat: string }[]
  myResponse: CalendarResponse | null
  /** You organize it. */
  mine: boolean
  /** Shown as free time, so it does not block the day. */
  free: boolean
}

export const SYNC_PAST_MS = 14 * 24 * 3600 * 1000
export const SYNC_AHEAD_MS = 120 * 24 * 3600 * 1000
const MAX_ATTENDEES = 50
const MAX_TEXT = 2000

const text = (v: unknown, max = MAX_TEXT): string => (typeof v === 'string' ? v.slice(0, max) : '')
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** Local midnight for a "2026-11-04" style date, which is how all-day events are kept. */
function localDate(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (!m) return null
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
  return Number.isNaN(t) ? null : t
}

// ---- Microsoft Graph -------------------------------------------------------------------

/** The first page of events between two moments. Ask with `Prefer: outlook.timezone="UTC"`. */
export function graphEventsUrl(from: number, to: number): string {
  const q = new URLSearchParams({
    startDateTime: new Date(from).toISOString(),
    endDateTime: new Date(to).toISOString(),
    $top: '200',
    $orderby: 'start/dateTime',
    $select: [
      'id', 'iCalUId', 'subject', 'bodyPreview', 'start', 'end', 'isAllDay', 'location', 'isCancelled', 'showAs',
      'onlineMeeting', 'organizer', 'attendees', 'responseStatus', 'isOrganizer'
    ].join(',')
  })
  return `https://graph.microsoft.com/v1.0/me/calendarView?${q}`
}

const GRAPH_RESPONSE: Record<string, CalendarResponse> = {
  accepted: 'accepted',
  tentativelyaccepted: 'tentative',
  declined: 'declined'
}
const GRAPH_PARTSTAT: Record<string, string> = {
  accepted: 'ACCEPTED',
  tentativelyaccepted: 'TENTATIVE',
  declined: 'DECLINED'
}

function graphTime(dt: unknown, allDay: boolean): number | null {
  const s = text(obj(dt)['dateTime'], 40)
  if (!s) return null
  if (allDay) return localDate(s)
  // Asked in UTC, so the time has no zone on it: "2026-11-04T19:00:00.0000000".
  const t = Date.parse(s.slice(0, 19) + 'Z')
  return Number.isNaN(t) ? null : t
}

/** Events from one page of a calendarView answer; cancelled and declined ones are left out. */
export function parseGraphEvents(json: unknown): RemoteEvent[] {
  const out: RemoteEvent[] = []
  for (const raw of arr(obj(json)['value'])) {
    const e = obj(raw)
    const id = text(e['id'], 500)
    const allDay = e['isAllDay'] === true
    const start = graphTime(e['start'], allDay)
    let end = graphTime(e['end'], allDay)
    if (!id || start === null) continue
    if (end === null || end < start) end = start
    if (e['isCancelled'] === true) continue
    const response = GRAPH_RESPONSE[text(obj(e['responseStatus'])['response'], 30).toLowerCase()] ?? null
    if (response === 'declined') continue

    const location = text(obj(e['location'])['displayName'], 500)
    const description = text(e['bodyPreview'])
    const org = obj(obj(e['organizer'])['emailAddress'])
    const orgEmail = text(org['address'], 320).toLowerCase()
    out.push({
      remoteId: id,
      uid: text(e['iCalUId'], 500) || id,
      summary: text(e['subject'], 500),
      description,
      location,
      start,
      end,
      allDay,
      status: text(e['showAs'], 20).toLowerCase() === 'tentative' ? 'TENTATIVE' : 'CONFIRMED',
      onlineUrl: safeWebUrl(text(obj(e['onlineMeeting'])['joinUrl'], 2000)) ?? findJoinLink(location, description),
      organizer: orgEmail ? { name: text(org['name'], 200), email: orgEmail } : null,
      attendees: arr(e['attendees'])
        .slice(0, MAX_ATTENDEES)
        .flatMap((a) => {
          const x = obj(a)
          const addr = obj(x['emailAddress'])
          const email = text(addr['address'], 320).toLowerCase()
          if (!email) return []
          const st = text(obj(x['status'])['response'], 30).toLowerCase()
          return [{ name: text(addr['name'], 200), email, partstat: GRAPH_PARTSTAT[st] ?? 'NEEDS-ACTION' }]
        }),
      myResponse: response,
      mine: e['isOrganizer'] === true,
      free: text(e['showAs'], 20).toLowerCase() === 'free'
    })
  }
  return out
}

/** The address of the next page of a Graph answer, only if it stays on Graph. */
export function graphNextLink(json: unknown): string | null {
  const next = text(obj(json)['@odata.nextLink'], 4000)
  return next.startsWith('https://graph.microsoft.com/') ? next : null
}

// ---- Google Calendar -------------------------------------------------------------------

export function googleEventsUrl(from: number, to: number, pageToken?: string): string {
  const q = new URLSearchParams({
    timeMin: new Date(from).toISOString(),
    timeMax: new Date(to).toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250',
    fields:
      'nextPageToken,items(id,iCalUID,summary,description,location,status,start,end,hangoutLink,conferenceData,organizer,attendees,transparency)'
  })
  if (pageToken) q.set('pageToken', pageToken)
  return `https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`
}

const GOOGLE_RESPONSE: Record<string, CalendarResponse> = { accepted: 'accepted', tentative: 'tentative', declined: 'declined' }
const GOOGLE_PARTSTAT: Record<string, string> = { accepted: 'ACCEPTED', tentative: 'TENTATIVE', declined: 'DECLINED' }

function googleTime(v: unknown): { ms: number; allDay: boolean } | null {
  const o = obj(v)
  const date = text(o['date'], 20)
  if (date) {
    const ms = localDate(date)
    return ms === null ? null : { ms, allDay: true }
  }
  const dt = text(o['dateTime'], 40)
  const ms = dt ? Date.parse(dt) : NaN
  return Number.isNaN(ms) ? null : { ms, allDay: false }
}

export function parseGoogleEvents(json: unknown): RemoteEvent[] {
  const out: RemoteEvent[] = []
  for (const raw of arr(obj(json)['items'])) {
    const e = obj(raw)
    const id = text(e['id'], 500)
    const start = googleTime(e['start'])
    const end = googleTime(e['end'])
    if (!id || !start) continue
    if (text(e['status'], 20) === 'cancelled') continue
    const attendees = arr(e['attendees']).map(obj)
    const me = attendees.find((a) => a['self'] === true)
    const response = GOOGLE_RESPONSE[text(me?.['responseStatus'], 20)] ?? null
    if (response === 'declined') continue

    const location = text(e['location'], 500)
    const description = text(e['description'])
    const entry = arr(obj(e['conferenceData'])['entryPoints'])
      .map(obj)
      .find((p) => p['entryPointType'] === 'video')
    const org = obj(e['organizer'])
    const orgEmail = text(org['email'], 320).toLowerCase()
    out.push({
      remoteId: id,
      uid: text(e['iCalUID'], 500) || id,
      summary: text(e['summary'], 500),
      description,
      location,
      start: start.ms,
      end: end && end.ms >= start.ms ? end.ms : start.ms,
      allDay: start.allDay,
      status: text(e['status'], 20) === 'tentative' ? 'TENTATIVE' : 'CONFIRMED',
      onlineUrl: safeWebUrl(text(e['hangoutLink'], 2000)) ?? safeWebUrl(text(entry?.['uri'], 2000)) ?? findJoinLink(location, description),
      organizer: orgEmail ? { name: text(org['displayName'], 200), email: orgEmail } : null,
      attendees: attendees.slice(0, MAX_ATTENDEES).flatMap((a) => {
        const email = text(a['email'], 320).toLowerCase()
        return email ? [{ name: text(a['displayName'], 200), email, partstat: GOOGLE_PARTSTAT[text(a['responseStatus'], 20)] ?? 'NEEDS-ACTION' }] : []
      }),
      myResponse: response,
      mine: org['self'] === true,
      free: text(e['transparency'], 20) === 'transparent'
    })
  }
  return out
}

export function googleNextPage(json: unknown): string | null {
  return text(obj(json)['nextPageToken'], 2000) || null
}
