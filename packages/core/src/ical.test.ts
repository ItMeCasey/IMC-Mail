import { describe, expect, it } from 'vitest'
import {
  buildICS,
  buildReply,
  describeRecurrence,
  escapeText,
  findJoinLink,
  foldLine,
  occurrences,
  parseICS,
  replySubject,
  unfold,
  resolveZone,
  zonedToUtc
} from './ical'

const crlf = (s: string) => s.trim().split(/\r?\n/).join('\r\n') + '\r\n'

/** What Exchange / Outlook actually sends for a Teams meeting (trimmed, same shape). */
const OUTLOOK_REQUEST = crlf(`
BEGIN:VCALENDAR
METHOD:REQUEST
PRODID:Microsoft Exchange Server 2010
VERSION:2.0
BEGIN:VTIMEZONE
TZID:Eastern Standard Time
BEGIN:STANDARD
DTSTART:16010101T020000
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:16010101T020000
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
ORGANIZER;CN="Lee, Pat":MAILTO:Pat@Nova.example
ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Casey:MAILTO:casey@me.example
ATTENDEE;ROLE=OPT-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Agent:MAILTO:agent@nova.example
DESCRIPTION;LANGUAGE=en-US:Join the call\\n\\nhttps://teams.microsoft.com/l/meetup-join/19%3ameeti
 ng_abc%40thread.v2/0?context=%7b%22Tid%22%3a%22x%22%7d\\n\\nQ4\\, rates\\; deliverables
UID:040000008200E00074C5B7101A82E00800000000AABB
SUMMARY;LANGUAGE=en-US:Q4 sponsorship kickoff
DTSTART;TZID=Eastern Standard Time:20261104T140000
DTEND;TZID=Eastern Standard Time:20261104T150000
CLASS:PUBLIC
DTSTAMP:20261025T120000Z
TRANSP:OPAQUE
STATUS:CONFIRMED
SEQUENCE:2
LOCATION;LANGUAGE=en-US:Microsoft Teams Meeting
BEGIN:VALARM
TRIGGER:-PT15M
ACTION:DISPLAY
DESCRIPTION:Reminder
END:VALARM
END:VEVENT
END:VCALENDAR
`)

describe('time zones', () => {
  it('maps Outlook (Windows) zone names and accepts IANA names', () => {
    expect(resolveZone('Eastern Standard Time')).toBe('America/New_York')
    expect(resolveZone('"Pacific Standard Time"')).toBe('America/Los_Angeles')
    expect(resolveZone('W. Europe Standard Time')).toBe('Europe/Berlin')
    expect(resolveZone('America/Chicago')).toBe('America/Chicago')
    expect(resolveZone('/mozilla.org/20050126_1/Europe/Paris')).toBe('Europe/Paris')
    expect(resolveZone('Nowhere Standard Time')).toBeNull()
  })
  it('converts wall time across daylight-saving changes', () => {
    // 14:00 in New York: EDT in July (UTC-4), EST in November (UTC-5)
    expect(zonedToUtc(2026, 7, 15, 14, 0, 0, 'America/New_York')).toBe(Date.UTC(2026, 6, 15, 18))
    expect(zonedToUtc(2026, 11, 4, 14, 0, 0, 'America/New_York')).toBe(Date.UTC(2026, 10, 4, 19))
    expect(zonedToUtc(2026, 11, 4, 14, 0, 0, 'Asia/Kolkata')).toBe(Date.UTC(2026, 10, 4, 8, 30))
  })
})

describe('parsing an Outlook / Exchange invitation', () => {
  const [ev] = parseICS(OUTLOOK_REQUEST)

  it('reads the core fields, unescaping text and unfolding lines', () => {
    expect(parseICS(OUTLOOK_REQUEST)).toHaveLength(1)
    expect(ev).toMatchObject({
      method: 'REQUEST',
      uid: '040000008200E00074C5B7101A82E00800000000AABB',
      sequence: 2,
      summary: 'Q4 sponsorship kickoff',
      location: 'Microsoft Teams Meeting',
      status: 'CONFIRMED',
      allDay: false,
      free: false,
      rrule: null
    })
    expect(ev!.description).toContain('Q4, rates; deliverables')
    expect(ev!.description).toContain('\n')
  })

  it('converts the Windows TZID to the right instants', () => {
    expect(ev!.start).toBe(Date.UTC(2026, 10, 4, 19, 0)) // 2:00 PM EST
    expect(ev!.end).toBe(Date.UTC(2026, 10, 4, 20, 0))
    expect(ev!.dtstamp).toBe(Date.UTC(2026, 9, 25, 12))
  })

  it('reads organizer and attendees case-insensitively, including quoted names with commas', () => {
    expect(ev!.organizer).toEqual({ name: 'Lee, Pat', email: 'pat@nova.example' })
    expect(ev!.attendees).toEqual([
      { name: 'Casey', email: 'casey@me.example', partstat: 'NEEDS-ACTION', role: 'REQ-PARTICIPANT', rsvp: true },
      { name: 'Agent', email: 'agent@nova.example', partstat: 'ACCEPTED', role: 'OPT-PARTICIPANT', rsvp: false }
    ])
  })

  it('finds the Teams join link in the description, ignoring the reminder alarm', () => {
    expect(ev!.onlineUrl).toBe('https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%22Tid%22%3a%22x%22%7d')
    expect(ev!.description).not.toContain('Reminder')
  })

  it('falls back to a VTIMEZONE offset for a zone name it does not know', () => {
    const ics = crlf(`
BEGIN:VCALENDAR
BEGIN:VTIMEZONE
TZID:Custom Plant Time
BEGIN:STANDARD
DTSTART:16010101T000000
TZOFFSETFROM:+0530
TZOFFSETTO:+0530
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:z1
DTSTART;TZID=Custom Plant Time:20261104T140000
DTEND;TZID=Custom Plant Time:20261104T150000
SUMMARY:Plant
END:VEVENT
END:VCALENDAR`)
    expect(parseICS(ics)[0]!.start).toBe(Date.UTC(2026, 10, 4, 8, 30))
  })
})

describe('other shapes real calendars send', () => {
  it('UTC times, DURATION, and TRANSPARENT', () => {
    const [ev] = parseICS(crlf(`
BEGIN:VCALENDAR
METHOD:PUBLISH
BEGIN:VEVENT
UID:g1@google.com
DTSTART:20261030T150000Z
DURATION:PT90M
SUMMARY:Stream planning
TRANSP:TRANSPARENT
X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij
END:VEVENT
END:VCALENDAR`))
    expect(ev).toMatchObject({ method: 'PUBLISH', start: Date.UTC(2026, 9, 30, 15), end: Date.UTC(2026, 9, 30, 16, 30), free: true, onlineUrl: 'https://meet.google.com/abc-defg-hij' })
  })

  it('all-day events', () => {
    const [ev] = parseICS(crlf(`
BEGIN:VCALENDAR
BEGIN:VEVENT
UID:d1
DTSTART;VALUE=DATE:20261224
DTEND;VALUE=DATE:20261226
SUMMARY:Holiday
END:VEVENT
END:VCALENDAR`))
    expect(ev).toMatchObject({ allDay: true, start: new Date(2026, 11, 24).getTime(), end: new Date(2026, 11, 26).getTime() })
  })

  it('cancellations and floating times', () => {
    const [ev] = parseICS(crlf(`
BEGIN:VCALENDAR
METHOD:CANCEL
BEGIN:VEVENT
UID:c1
SEQUENCE:3
STATUS:CANCELLED
DTSTART:20261104T140000
SUMMARY:Cancelled: Kickoff
END:VEVENT
END:VCALENDAR`))
    expect(ev).toMatchObject({ method: 'CANCEL', status: 'CANCELLED', sequence: 3, start: new Date(2026, 10, 4, 14).getTime() })
  })

  it('a reply carries the attendee response', () => {
    const [ev] = parseICS(crlf(`
BEGIN:VCALENDAR
METHOD:REPLY
BEGIN:VEVENT
UID:r1
DTSTART:20261104T190000Z
ORGANIZER:mailto:pat@nova.example
ATTENDEE;PARTSTAT=TENTATIVE;CN=Casey:mailto:casey@me.example
END:VEVENT
END:VCALENDAR`))
    expect(ev!.method).toBe('REPLY')
    expect(ev!.attendees[0]).toMatchObject({ email: 'casey@me.example', partstat: 'TENTATIVE' })
  })

  it('never throws on junk, and skips events with no UID or start', () => {
    expect(parseICS('')).toEqual([])
    expect(parseICS('not a calendar at all')).toEqual([])
    expect(parseICS('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:x\r\nEND:VEVENT\r\nEND:VCALENDAR')).toEqual([])
    expect(parseICS('BEGIN:VEVENT\r\nUID:x\r\nDTSTART:garbage\r\nEND:VEVENT')).toEqual([])
  })

  it('keeps an override of one occurrence apart from the series', () => {
    const evs = parseICS(crlf(`
BEGIN:VCALENDAR
BEGIN:VEVENT
UID:s1
DTSTART:20261102T150000Z
RRULE:FREQ=WEEKLY;BYDAY=MO
SUMMARY:Standup
END:VEVENT
BEGIN:VEVENT
UID:s1
RECURRENCE-ID:20261109T150000Z
DTSTART:20261109T160000Z
SUMMARY:Standup (moved)
END:VEVENT
END:VCALENDAR`))
    expect(evs).toHaveLength(2)
    expect(evs[1]!.recurrenceId).toBe(Date.UTC(2026, 10, 9, 15))
  })
})

describe('findJoinLink', () => {
  it('spots Teams, Zoom, Meet and Webex links', () => {
    expect(findJoinLink('see https://us02web.zoom.us/j/123456789?pwd=abc.')).toBe('https://us02web.zoom.us/j/123456789?pwd=abc')
    expect(findJoinLink('https://meet.google.com/abc-defg-hij')).toBe('https://meet.google.com/abc-defg-hij')
    expect(findJoinLink('nothing here')).toBeNull()
  })
})

describe('recurrence', () => {
  const base = (rrule: string, extra: Partial<Parameters<typeof occurrences>[0]> = {}) => ({
    ...parseICS(crlf(`
BEGIN:VCALENDAR
BEGIN:VEVENT
UID:x
DTSTART:20261102T150000Z
DTEND:20261102T160000Z
RRULE:${rrule}
SUMMARY:S
END:VEVENT
END:VCALENDAR`))[0]!,
    ...extra
  })
  const from = new Date(2026, 10, 1).getTime()
  const to = new Date(2026, 11, 31).getTime()

  it('weekly on chosen days, honouring COUNT', () => {
    const occ = occurrences(base('FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5'), from, to)
    expect(occ).toHaveLength(5)
    expect(occ.map((t) => new Date(t).getDay())).toEqual([1, 3, 1, 3, 1])
  })

  it('daily with an interval, UNTIL, and EXDATE', () => {
    const ev = base('FREQ=DAILY;INTERVAL=2;UNTIL=20261110T000000Z')
    const all = occurrences(ev, from, to)
    expect(all).toHaveLength(4) // Nov 2, 4, 6, 8 (the 10th at 15:00 is after the 00:00 UNTIL)
    const skipped = occurrences({ ...ev, exdates: [all[1]!] }, from, to)
    expect(skipped).toHaveLength(3)
    expect(skipped).not.toContain(all[1])
  })

  it('monthly on the nth weekday and on a day of the month', () => {
    const second = occurrences(base('FREQ=MONTHLY;BYDAY=2TU;COUNT=3'), from, new Date(2027, 5, 1).getTime())
    expect(second.map((t) => new Date(t).getDay())).toEqual([2, 2, 2])
    expect(second.map((t) => Math.ceil(new Date(t).getDate() / 7))).toEqual([2, 2, 2])
    expect(occurrences(base('FREQ=MONTHLY;BYMONTHDAY=15;COUNT=2'), from, new Date(2027, 5, 1).getTime()).map((t) => new Date(t).getDate())).toEqual([15, 15])
  })

  it('a single event is just itself, only when it falls in the window', () => {
    const ev = { ...base('FREQ=DAILY'), rrule: null }
    expect(occurrences(ev, from, to)).toEqual([ev.start])
    expect(occurrences(ev, to, to + 1000)).toEqual([])
  })

  it('describes rules in words', () => {
    expect(describeRecurrence('FREQ=WEEKLY;BYDAY=MO,WE')).toBe('Every week on Monday, Wednesday')
    expect(describeRecurrence('FREQ=DAILY;INTERVAL=3;COUNT=4')).toBe('Every 3 days, 4 times')
    expect(describeRecurrence('FREQ=MONTHLY;BYDAY=2TU')).toBe('Every month on the second Tuesday')
    expect(describeRecurrence('FREQ=NOPE')).toBe('Repeats')
    expect(describeRecurrence(null)).toBeNull()
  })
})

describe('writing iCalendar', () => {
  const NOW = Date.UTC(2026, 9, 25, 12)
  const meeting = {
    uid: 'abc123@imc-mail',
    sequence: 0,
    summary: 'Rates, scope; "next steps"',
    description: 'Line one\nLine two',
    location: 'Zoom',
    start: Date.UTC(2026, 10, 4, 19),
    end: Date.UTC(2026, 10, 4, 20),
    organizer: { name: 'Casey', email: 'me@imc.example' },
    attendees: [{ name: 'Pat Lee', email: 'pat@nova.example' }]
  }

  it('escapes text, uses CRLF, and keeps every line within 75 octets', () => {
    const ics = buildICS('REQUEST', { ...meeting, description: 'é'.repeat(120) + ' and a long tail of words '.repeat(8) }, NOW)
    expect(ics.endsWith('\r\n')).toBe(true)
    expect(ics).not.toMatch(/[^\r]\n/)
    for (const line of ics.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75)
    expect(escapeText('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne')
  })

  it('a line break in a field cannot start a new calendar property', () => {
    const ics = buildICS(
      'REQUEST',
      { ...meeting, uid: 'x@imc\r\nATTENDEE:mailto:evil@x.example', onlineUrl: 'https://ok.example/a\r\nORGANIZER:mailto:evil@x.example' },
      NOW
    )
    const props = ics.split('\r\n').filter((l) => !l.startsWith(' '))
    expect(props.some((l) => l.includes('evil@x.example') && !/^(UID|URL|X-MICROSOFT-SKYPETEAMSMEETINGURL):/.test(l))).toBe(false)
    expect(props.filter((l) => l.startsWith('ORGANIZER'))).toHaveLength(1)
  })

  it('ignores a meeting link that is not a plain web address', () => {
    const wrap = (extra: string) => crlf(`
BEGIN:VCALENDAR
METHOD:REQUEST
VERSION:2.0
BEGIN:VEVENT
UID:u1@x
DTSTART:20261104T190000Z
DTEND:20261104T200000Z
SUMMARY:Hi
${extra}
END:VEVENT
END:VCALENDAR
`)
    expect(parseICS(wrap('URL:https://meet.example.com/j/1'))[0]!.onlineUrl).toBe('https://meet.example.com/j/1')
    expect(parseICS(wrap('URL:https://x.example/"onmouseover="alert(1)'))[0]!.onlineUrl).toBeNull()
    expect(parseICS(wrap('URL:javascript:alert(1)'))[0]!.onlineUrl).toBeNull()
    expect(parseICS(wrap('URL:file:///C:/Windows/System32/calc.exe'))[0]!.onlineUrl).toBeNull()
  })

  it('does not split multi-byte characters when folding', () => {
    const folded = foldLine('DESCRIPTION:' + '日本語'.repeat(40))
    expect(folded.replace(/\r\n /g, '')).toBe('DESCRIPTION:' + '日本語'.repeat(40))
    expect(folded).not.toContain('�')
  })

  it('an invitation round-trips through our own parser, the way Outlook will read it', () => {
    const raw = buildICS('REQUEST', meeting, NOW)
    const ics = unfold(raw) // long lines are folded on the wire
    expect(ics).toContain('METHOD:REQUEST')
    expect(ics).toContain('PRODID:-//IMC-Mail//Calendar 1.0//EN')
    expect(ics).toContain('DTSTART:20261104T190000Z')
    expect(ics).toMatch(/ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN="?Pat Lee"?:mailto:pat@nova.example/)
    expect(ics).toContain('X-MICROSOFT-CDO-BUSYSTATUS:BUSY')
    const [back] = parseICS(raw)
    expect(back).toMatchObject({
      method: 'REQUEST',
      uid: 'abc123@imc-mail',
      summary: 'Rates, scope; "next steps"',
      description: 'Line one\nLine two',
      start: meeting.start,
      end: meeting.end,
      status: 'CONFIRMED',
      organizer: { name: 'Casey', email: 'me@imc.example' }
    })
    expect(back!.attendees[0]).toMatchObject({ email: 'pat@nova.example', partstat: 'NEEDS-ACTION', rsvp: true })
  })

  it('all-day invitations use VALUE=DATE', () => {
    const ics = buildICS('REQUEST', { ...meeting, allDay: true, start: new Date(2026, 11, 24).getTime(), end: new Date(2026, 11, 25).getTime() }, NOW)
    expect(ics).toContain('DTSTART;VALUE=DATE:20261224')
    expect(ics).toContain('X-MICROSOFT-CDO-ALLDAYEVENT:TRUE')
    expect(parseICS(ics)[0]).toMatchObject({ allDay: true, start: new Date(2026, 11, 24).getTime() })
  })

  it('a reply to an Outlook request keeps UID and SEQUENCE and carries only the replier', () => {
    const [request] = parseICS(OUTLOOK_REQUEST)
    const raw = buildReply(request!, { name: 'Casey', email: 'casey@me.example' }, 'ACCEPTED', 'See you there', NOW)
    const reply = unfold(raw)
    expect(reply).toContain('METHOD:REPLY')
    expect(reply).toContain('UID:040000008200E00074C5B7101A82E00800000000AABB')
    expect(reply).toContain('SEQUENCE:2')
    expect(reply).toContain('PARTSTAT=ACCEPTED')
    expect(reply).toContain('RSVP=FALSE')
    expect(reply).toContain('ORGANIZER;CN="Lee, Pat":mailto:pat@nova.example')
    expect(reply).toContain('COMMENT:See you there')
    expect(reply).not.toContain('agent@nova.example') // only the person replying
    expect(reply).not.toContain('DESCRIPTION') // no body in a reply
    const [back] = parseICS(raw)
    expect(back!.attendees).toHaveLength(1)
    expect(back!.attendees[0]).toMatchObject({ email: 'casey@me.example', partstat: 'ACCEPTED' })
    expect(back!.start).toBe(request!.start)
  })

  it('refuses to reply to an invitation with no organizer', () => {
    const [ev] = parseICS(crlf('BEGIN:VEVENT\nUID:x\nDTSTART:20261104T190000Z\nEND:VEVENT'))
    expect(() => buildReply(ev!, { name: '', email: 'a@b.co' }, 'DECLINED')).toThrow(/organized/)
  })

  it('cancellations bump nothing themselves and say CANCELLED', () => {
    const ics = buildICS('CANCEL', { ...meeting, sequence: 3 }, NOW)
    expect(ics).toContain('METHOD:CANCEL')
    expect(ics).toContain('SEQUENCE:3')
    expect(ics).toContain('STATUS:CANCELLED')
  })

  it('uses the subject lines Outlook uses', () => {
    expect(replySubject('ACCEPTED', 'Kickoff')).toBe('Accepted: Kickoff')
    expect(replySubject('TENTATIVE', 'Kickoff')).toBe('Tentative: Kickoff')
    expect(replySubject('DECLINED', 'Kickoff')).toBe('Declined: Kickoff')
  })
})

describe('repeating meetings keep their wall-clock hour', () => {
  const base = {
    uid: 'u@x', sequence: 0, summary: 'Weekly sync', start: Date.UTC(2026, 10, 4, 19), end: Date.UTC(2026, 10, 4, 20),
    organizer: { name: 'Casey', email: 'me@x.example' }, attendees: [{ email: 'pat@nova.example' }]
  }
  it('writes TZID, a VTIMEZONE with the daylight changes, and round-trips to the same instants', () => {
    const ics = buildICS('REQUEST', { ...base, rrule: 'FREQ=WEEKLY;COUNT=20', zone: 'America/New_York' })
    const flat = unfold(ics)
    expect(flat).toContain('DTSTART;TZID=Eastern Standard Time:20261104T140000')
    expect(flat).toContain('BEGIN:VTIMEZONE')
    expect(flat).toMatch(/BEGIN:DAYLIGHT\r\nDTSTART:20270314T020000\r\nTZOFFSETFROM:-0500\r\nTZOFFSETTO:-0400/)
    expect(flat).toMatch(/BEGIN:STANDARD\r\nDTSTART:20271107T020000\r\nTZOFFSETFROM:-0400\r\nTZOFFSETTO:-0500/)
    const [back] = parseICS(ics)
    expect(back).toMatchObject({ start: base.start, end: base.end, rrule: 'FREQ=WEEKLY;COUNT=20' })
  })
  it('a zone with no daylight saving gets one base component', () => {
    const flat = unfold(buildICS('REQUEST', { ...base, rrule: 'FREQ=DAILY;COUNT=3', zone: 'Asia/Kolkata' }))
    expect(flat).toContain('TZOFFSETTO:+0530')
    expect(flat.match(/BEGIN:(STANDARD|DAYLIGHT)/g)).toHaveLength(1)
  })
  it('stays in UTC when the meeting does not repeat, and for all-day meetings', () => {
    expect(buildICS('REQUEST', { ...base, zone: 'America/New_York' })).toContain('DTSTART:20261104T190000Z')
    expect(buildICS('REQUEST', { ...base, allDay: true, rrule: 'FREQ=DAILY;COUNT=2', zone: 'America/New_York' })).toContain('DTSTART;VALUE=DATE:')
  })
})
