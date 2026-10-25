import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { simpleParser } from 'mailparser'
import { SMTPServer } from 'smtp-server'
import { parseICS, type CalEvent, type ImapAccountInput } from '@imc/core'
import { CalendarService } from './calendar'
import { ComposeService, SmtpMailer } from './compose'
import { migrate } from './db'
import { MailStore } from './store'

const crlf = (s: string) => s.trim().split(/\r?\n/).join('\r\n') + '\r\n'

/** Trimmed from what Exchange sends for a Teams meeting. */
const REQUEST = (over: { seq?: number; start?: string; method?: string } = {}) =>
  crlf(`
BEGIN:VCALENDAR
METHOD:${over.method ?? 'REQUEST'}
PRODID:Microsoft Exchange Server 2010
VERSION:2.0
BEGIN:VEVENT
ORGANIZER;CN="Lee, Pat":MAILTO:Pat@Nova.example
ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Casey:MAILTO:me@x.example
ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Agent:MAILTO:agent@nova.example
DESCRIPTION:Join https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0?context=1
UID:UID-KICKOFF-1
SUMMARY:Q4 sponsorship kickoff
DTSTART;TZID=Eastern Standard Time:${over.start ?? '20261104T140000'}
DTEND;TZID=Eastern Standard Time:${(over.start ?? '20261104T140000').replace('T14', 'T15')}
DTSTAMP:20261025T120000Z
STATUS:${over.method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}
SEQUENCE:${over.seq ?? 0}
LOCATION:Microsoft Teams Meeting
END:VEVENT
END:VCALENDAR
`)

const input: ImapAccountInput = {
  email: 'me@x.example',
  displayName: 'Casey',
  username: 'me',
  password: 'pw',
  imap: { host: '127.0.0.1', port: 1, security: 'tls' },
  smtp: { host: '127.0.0.1', port: 0, security: 'none' }
}

interface Sent {
  raw: string
  rcpt: string[]
}
let server: SMTPServer
let sent: Sent[]

beforeEach(async () => {
  sent = []
  server = new SMTPServer({
    authOptional: false,
    allowInsecureAuth: true,
    disabledCommands: ['STARTTLS'],
    logger: false,
    onAuth: (a, _s, cb) => (a.username === 'me' && a.password === 'pw' ? cb(null, { user: 'me' }) : cb(new Error('bad login'))),
    onData(stream, session, cb) {
      const chunks: Buffer[] = []
      stream.on('data', (c: Buffer) => chunks.push(c))
      stream.on('end', () => {
        sent.push({ raw: Buffer.concat(chunks).toString('utf8'), rcpt: session.envelope.rcptTo.map((r) => r.address) })
        cb()
      })
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
})
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

function setup() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  const store = new MailStore(db)
  const port = (server.server.address() as { port: number }).port
  const acct = store.addAccount({ ...input, smtp: { host: '127.0.0.1', port, security: 'none' } }, 'imap').id
  const inbox = store.upsertFolder(acct, { path: 'INBOX', name: 'Inbox', role: 'inbox' })
  let clock = Date.UTC(2026, 9, 25, 12)
  const compose = new ComposeService(store, new SmtpMailer({ get: async () => ({ pass: 'pw' }) }), {
    outboxDir: mkdtempSync(join(tmpdir(), 'imc-cal-')),
    ensureBody: async () => ({ html: null, text: '', to: '', cc: '', attachments: [], truncated: false }),
    onChange: () => {},
    onSent: () => {},
    now: () => clock
  })
  const cal = new CalendarService(store, { send: (d, o) => compose.send(d, o) }, () => clock, 'America/New_York')
  store.applyFetched(
    acct,
    inbox,
    [{ uid: 1, messageId: '<inv@x>', fromName: 'Pat', fromAddr: 'pat@nova.example', to: 'me@x.example', subject: 'Invitation: Q4 sponsorship kickoff', date: clock - 1000, flags: [], refs: [] }],
    null
  )
  const msgId = `${inbox}:1`
  const ingest = (ics: string, id = msgId) => cal.ingest(acct, id, parseICS(ics))
  const flush = async () => {
    clock += 11_000 // past the undo window that organizer mail waits through
    await compose.tick()
  }
  return { store, cal, compose, acct, inbox, msgId, ingest, flush, advance: (ms: number) => (clock += ms), now: () => clock }
}

/** The calendar part of a sent message, and the method it declared. */
async function calendarPart(raw: string) {
  const mail = await simpleParser(raw)
  const att = mail.attachments.find((a) => /^text\/calendar/i.test(a.contentType))
  const header = /Content-Type:\s*text\/calendar;[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*/i.exec(raw)?.[0] ?? ''
  return { mail, events: att ? parseICS(att.content.toString('utf8')) : [], header }
}

describe('receiving an Outlook invitation', () => {
  it('records the meeting, shows the invite on the message, and flags it on the list', () => {
    const t = setup()
    t.ingest(REQUEST())
    const inv = t.cal.inviteFor(t.msgId)!
    expect(inv.method).toBe('REQUEST')
    expect(inv.event).toMatchObject({
      summary: 'Q4 sponsorship kickoff',
      start: Date.UTC(2026, 10, 4, 19), // 2 PM EST
      end: Date.UTC(2026, 10, 4, 20),
      status: 'CONFIRMED',
      myResponse: null,
      mine: false,
      organizer: { name: 'Lee, Pat', email: 'pat@nova.example' },
      onlineUrl: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0?context=1'
    })
    expect(inv.outdated).toBe(false)
    expect(t.store.listMessages({ limit: 5, offset: 0 }, 0)[0]?.invite).toBe(true)
  })

  it('an update with a new time clears your answer; an update with the same time keeps it', async () => {
    const t = setup()
    t.ingest(REQUEST())
    await t.cal.respond(t.msgId, 'accepted')
    t.ingest(REQUEST({ seq: 1 })) // same time, e.g. a changed description
    expect(t.store.getEvent(t.cal.inviteFor(t.msgId)!.event.id)?.myResponse).toBe('accepted')
    t.ingest(REQUEST({ seq: 2, start: '20261105T140000' })) // moved a day
    const e = t.store.getEvent(t.cal.inviteFor(t.msgId)!.event.id)!
    expect(e).toMatchObject({ myResponse: null, sequence: 2 })
    expect(e.start).toBe(Date.UTC(2026, 10, 5, 19))
  })

  it('ignores an older version that arrives late, and marks that message outdated', () => {
    const t = setup()
    t.ingest(REQUEST({ seq: 3, start: '20261106T140000' }))
    t.store.applyFetched(t.acct, t.inbox, [{ uid: 2, messageId: '<old@x>', fromName: 'Pat', fromAddr: 'pat@nova.example', to: 'me@x.example', subject: 'Invitation', date: 1, flags: [], refs: [] }], null)
    t.ingest(REQUEST({ seq: 1 }), `${t.inbox}:2`)
    const stored = t.store.eventsByUid(t.acct, 'UID-KICKOFF-1')[0]!
    expect(stored.sequence).toBe(3)
    expect(stored.start).toBe(Date.UTC(2026, 10, 6, 19))
    expect(t.cal.inviteFor(`${t.inbox}:2`)!.outdated).toBe(true)
  })

  it('a cancellation marks the meeting cancelled and takes it off the agenda', () => {
    const t = setup()
    t.ingest(REQUEST())
    t.ingest(REQUEST({ method: 'CANCEL', seq: 1 }))
    expect(t.cal.inviteFor(t.msgId)!.event.status).toBe('CANCELLED')
    expect(t.cal.list(0, Date.UTC(2027, 0, 1))).toHaveLength(0)
  })

  it('adopts an answer that Outlook already recorded on the attendee line', () => {
    const t = setup()
    t.ingest(REQUEST().replace('PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Casey', 'PARTSTAT=ACCEPTED;RSVP=TRUE;CN=Casey'))
    expect(t.cal.inviteFor(t.msgId)!.event.myResponse).toBe('accepted')
  })

  it('warns about overlapping meetings you accepted', async () => {
    const t = setup()
    t.ingest(REQUEST())
    await t.cal.respond(t.msgId, 'accepted')
    t.store.applyFetched(t.acct, t.inbox, [{ uid: 5, messageId: '<b@x>', fromName: 'B', fromAddr: 'b@z.example', to: 'me@x.example', subject: 'Other', date: 5, flags: [], refs: [] }], null)
    t.ingest(
      REQUEST()
        .replace('UID-KICKOFF-1', 'UID-OTHER')
        .replace('Q4 sponsorship kickoff', 'Podcast recording')
        .replace(/20261104T140000/g, '20261104T143000')
        .replace('20261104T150000', '20261104T153000'),
      `${t.inbox}:5`
    )
    const inv = t.cal.inviteFor(`${t.inbox}:5`)!
    expect(inv.conflicts.map((c) => c.summary)).toEqual(['Q4 sponsorship kickoff'])
    // ...and the first one is told about the second only once that is accepted too.
    expect(t.cal.inviteFor(t.msgId)!.conflicts).toEqual([])
  })
})

describe('answering an invitation (what Outlook has to understand)', () => {
  it.each([
    ['accepted', 'ACCEPTED', 'Accepted: Q4 sponsorship kickoff'],
    ['tentative', 'TENTATIVE', 'Tentative: Q4 sponsorship kickoff'],
    ['declined', 'DECLINED', 'Declined: Q4 sponsorship kickoff']
  ] as const)('%s sends an iMIP REPLY to the organizer', async (response, partstat, subject) => {
    const t = setup()
    t.ingest(REQUEST({ seq: 2 }))
    const e = await t.cal.respond(t.msgId, response, 'Looking forward to it')
    expect(e.myResponse).toBe(response)
    await t.flush()

    expect(sent).toHaveLength(1)
    expect(sent[0]!.rcpt).toEqual(['pat@nova.example']) // the organizer, not the sender
    const { mail, events, header } = await calendarPart(sent[0]!.raw)
    expect(mail.subject).toBe(subject)
    expect(header).toMatch(/method=REPLY/i)
    expect(sent[0]!.raw).toMatch(/Content-Class:\s*urn:content-classes:calendarmessage/i)
    expect(events).toHaveLength(1)
    const reply = events[0]!
    expect(reply).toMatchObject({ method: 'REPLY', uid: 'UID-KICKOFF-1', sequence: 2, start: Date.UTC(2026, 10, 4, 19) })
    expect(reply.attendees).toHaveLength(1)
    expect(reply.attendees[0]).toMatchObject({ email: 'me@x.example', partstat })
    expect(reply.organizer?.email).toBe('pat@nova.example')
    expect(mail.text).toContain('Looking forward to it')
  })

  it('goes out at once, without the usual undo wait', async () => {
    const t = setup()
    t.ingest(REQUEST())
    await t.cal.respond(t.msgId, 'accepted')
    await t.flush()
    expect(sent).toHaveLength(1)
  })

  it('refuses to answer your own meeting, a cancelled one, or a message with no invitation', async () => {
    const t = setup()
    await expect(t.cal.respond(t.msgId, 'accepted')).rejects.toThrow(/no meeting invitation/)
    t.ingest(REQUEST())
    t.ingest(REQUEST({ method: 'CANCEL', seq: 1 }))
    await expect(t.cal.respond(t.msgId, 'accepted')).rejects.toThrow(/cancelled/)
  })

  it('replies as the invited address even when an alias or list received it', async () => {
    const t = setup()
    t.ingest(REQUEST().replace('MAILTO:me@x.example', 'MAILTO:team-list@nova.example'))
    await t.cal.respond(t.msgId, 'accepted')
    await t.flush()
    const { events } = await calendarPart(sent[0]!.raw)
    expect(events[0]!.attendees[0]!.email).toBe('me@x.example')
  })
})

describe('scheduling meetings', () => {
  const meeting = (t: ReturnType<typeof setup>) => ({
    accountId: t.acct,
    summary: 'Rates call',
    location: 'Zoom',
    description: 'Agenda: rates, scope',
    start: Date.UTC(2026, 10, 6, 17),
    end: Date.UTC(2026, 10, 6, 17, 30),
    attendees: ['Pat Lee <pat@nova.example>', 'agent@nova.example', 'ME@x.example', 'pat@nova.example'],
    onlineUrl: 'https://us02web.zoom.us/j/123456789'
  })

  it('sends a REQUEST Outlook shows as a meeting invitation', async () => {
    const t = setup()
    const e = await t.cal.schedule(meeting(t))
    expect(e).toMatchObject({ summary: 'Rates call', mine: true, sequence: 0, status: 'CONFIRMED' })
    expect(e.attendees.map((a) => a.email)).toEqual(['pat@nova.example', 'agent@nova.example']) // no yourself, no duplicates
    expect(e.uid).toMatch(/^[0-9a-f-]{36}@x\.example$/)
    await t.flush()

    expect(sent[0]!.rcpt.sort()).toEqual(['agent@nova.example', 'pat@nova.example'])
    const { mail, events, header } = await calendarPart(sent[0]!.raw)
    expect(mail.subject).toBe('Rates call')
    expect(header).toMatch(/method=REQUEST/i)
    expect(sent[0]!.raw).toMatch(/Content-Class:\s*urn:content-classes:calendarmessage/i)
    const inv = events[0]!
    expect(inv).toMatchObject({ method: 'REQUEST', uid: e.uid, sequence: 0, summary: 'Rates call', start: meeting(t).start, end: meeting(t).end, location: 'Zoom' })
    expect(inv.organizer).toEqual({ name: 'Casey', email: 'me@x.example' })
    expect(inv.attendees.map((a) => [a.email, a.partstat, a.rsvp])).toEqual([
      ['pat@nova.example', 'NEEDS-ACTION', true],
      ['agent@nova.example', 'NEEDS-ACTION', true]
    ])
    expect(inv.onlineUrl).toBe('https://us02web.zoom.us/j/123456789')
    // The readable body is there for clients that do not show calendar parts.
    expect(mail.html).toContain('Rates call')
    expect(mail.text).toContain('When:')
  })

  it('shows up on your own agenda, and attendees\' replies update it', async () => {
    const t = setup()
    const e = await t.cal.schedule(meeting(t))
    expect(t.cal.list(0, Date.UTC(2027, 0, 1)).map((o) => o.event.summary)).toEqual(['Rates call'])

    // Pat accepts from Outlook: an iMIP REPLY lands in your inbox.
    t.store.applyFetched(t.acct, t.inbox, [{ uid: 9, messageId: '<r@x>', fromName: 'Pat', fromAddr: 'pat@nova.example', to: 'me@x.example', subject: 'Accepted: Rates call', date: 9, flags: [], refs: [] }], null)
    t.ingest(
      crlf(`
BEGIN:VCALENDAR
METHOD:REPLY
BEGIN:VEVENT
UID:${e.uid}
SEQUENCE:0
DTSTART:20261106T170000Z
DTEND:20261106T173000Z
ORGANIZER:mailto:me@x.example
ATTENDEE;PARTSTAT=ACCEPTED;CN=Pat Lee:mailto:pat@nova.example
END:VEVENT
END:VCALENDAR`),
      `${t.inbox}:9`
    )
    const stored = t.store.getEvent(e.id)!
    expect(stored.attendees.find((a) => a.email === 'pat@nova.example')?.partstat).toBe('ACCEPTED')
    expect(stored.attendees.find((a) => a.email === 'agent@nova.example')?.partstat).toBe('NEEDS-ACTION')
  })

  it('an update bumps SEQUENCE, resends, and asks everyone to answer again if the time moved', async () => {
    const t = setup()
    const e = await t.cal.schedule(meeting(t))
    await t.flush()
    sent.length = 0
    const moved = await t.cal.update(e.id, { start: Date.UTC(2026, 10, 7, 17), end: Date.UTC(2026, 10, 7, 17, 30) })
    expect(moved.sequence).toBe(1)
    await t.flush()
    const { mail, events } = await calendarPart(sent[0]!.raw)
    expect(mail.subject).toBe('Updated: Rates call')
    expect(events[0]).toMatchObject({ method: 'REQUEST', uid: e.uid, sequence: 1, start: Date.UTC(2026, 10, 7, 17) })
  })

  it('a cancellation sends METHOD:CANCEL with a higher SEQUENCE and leaves your agenda', async () => {
    const t = setup()
    const e = await t.cal.schedule(meeting(t))
    await t.flush()
    sent.length = 0
    const gone = await t.cal.cancel(e.id)
    expect(gone.status).toBe('CANCELLED')
    await t.flush()
    const { mail, events, header } = await calendarPart(sent[0]!.raw)
    expect(mail.subject).toBe('Canceled: Rates call')
    expect(header).toMatch(/method=CANCEL/i)
    expect(events[0]).toMatchObject({ method: 'CANCEL', status: 'CANCELLED', sequence: 1 })
    expect(t.cal.list(0, Date.UTC(2027, 0, 1))).toHaveLength(0)
  })

  it('only the organizer can change or cancel, and bad input is refused', async () => {
    const t = setup()
    t.ingest(REQUEST())
    const theirs = t.cal.inviteFor(t.msgId)!.event.id
    await expect(t.cal.update(theirs, { summary: 'x' })).rejects.toThrow(/organizer/)
    await expect(t.cal.cancel(theirs)).rejects.toThrow(/organizer/)
    await expect(t.cal.schedule({ ...meeting(t), end: meeting(t).start })).rejects.toThrow(/end after/)
    await expect(t.cal.schedule({ ...meeting(t), attendees: ['me@x.example'] })).rejects.toThrow(/at least one attendee/)
    await expect(t.cal.schedule({ ...meeting(t), attendees: ['not an address'] })).rejects.toThrow(/valid email/)
    await expect(t.cal.update('nope', {})).rejects.toThrow(/no longer exists/)
  })
})

describe('agenda and export', () => {
  it('expands repeating meetings and leaves out declined ones', async () => {
    const t = setup()
    t.ingest(
      REQUEST().replace('SEQUENCE:0', 'SEQUENCE:0\r\nRRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=3'),
    )
    const occ = t.cal.list(Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 31))
    expect(occ).toHaveLength(3)
    expect(occ[0]!.event.repeats).toBe('Every week on Wednesday, 3 times')
    expect(occ.map((o) => o.end - o.start)).toEqual([3600e3, 3600e3, 3600e3])
    await t.cal.respond(t.msgId, 'declined')
    expect(t.cal.list(Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 31))).toHaveLength(0)
  })

  it('exports an .ics file Outlook can open', () => {
    const t = setup()
    t.ingest(REQUEST())
    const id = t.cal.inviteFor(t.msgId)!.event.id
    const { filename, content } = t.cal.exportIcs(id)
    expect(filename).toBe('Q4 sponsorship kickoff.ics')
    expect(content).toContain('BEGIN:VCALENDAR')
    expect(content.endsWith('\r\n')).toBe(true)
    const [back] = parseICS(content) as CalEvent[]
    expect(back).toMatchObject({ uid: 'UID-KICKOFF-1', summary: 'Q4 sponsorship kickoff', start: Date.UTC(2026, 10, 4, 19) })
  })
})

describe('repeating and all-day meetings you organize', () => {
  const meeting = (t: ReturnType<typeof setup>, over = {}) => ({
    accountId: t.acct, summary: 'Weekly sync', location: '', description: '',
    start: Date.UTC(2026, 10, 4, 19), end: Date.UTC(2026, 10, 4, 20),
    attendees: ['pat@nova.example'], onlineUrl: null, ...over
  })

  it('sends a weekly series with a TZID, a VTIMEZONE and the repeat rule, and lists every occurrence', async () => {
    const t = setup()
    const e = await t.cal.schedule(meeting(t, { repeat: 'weekly', repeatCount: 4 }))
    expect(e.rrule).toBe('FREQ=WEEKLY;COUNT=4')
    expect(e.repeats).toBe('Every week, 4 times')
    await t.flush()
    expect(sent[0]!.raw).toMatch(/DTSTART;TZID=Eastern Standard Time:20261104T140000/)
    expect(sent[0]!.raw).toMatch(/BEGIN:VTIMEZONE/)
    expect(sent[0]!.raw).toMatch(/RRULE:FREQ=WEEKLY;COUNT=4/)
    const { events } = await calendarPart(sent[0]!.raw)
    expect(events[0]).toMatchObject({ rrule: 'FREQ=WEEKLY;COUNT=4', start: Date.UTC(2026, 10, 4, 19) })
    expect(t.cal.list(0, Date.UTC(2027, 3, 1))).toHaveLength(4)
  })

  it('an edit keeps the series unless you change the repeat, and changing it asks everyone to answer again', async () => {
    const t = setup()
    const e = await t.cal.schedule(meeting(t, { repeat: 'biweekly', repeatCount: 6 }))
    expect(e.rrule).toBe('FREQ=WEEKLY;INTERVAL=2;COUNT=6')
    expect((await t.cal.update(e.id, { summary: 'Sync (renamed)' })).rrule).toBe(e.rrule)
    expect((await t.cal.update(e.id, { repeat: 'none' })).rrule).toBeNull()
  })

  it('sends an all-day meeting as dates, with no time zone', async () => {
    const t = setup()
    const day = new Date(2026, 10, 6).getTime()
    await t.cal.schedule(meeting(t, { allDay: true, start: day, end: day + 86_400_000 }))
    await t.flush()
    expect(sent[0]!.raw).toMatch(/DTSTART;VALUE=DATE:20261106/)
    expect(sent[0]!.raw).toMatch(/DTEND;VALUE=DATE:20261107/)
    expect(sent[0]!.raw).not.toMatch(/VTIMEZONE/)
  })

  it('exports your own series with its repeat rule, but an invited one as a single occurrence', () => {
    const t = setup()
    t.ingest(REQUEST().replace('SEQUENCE:0', 'SEQUENCE:0\r\nRRULE:FREQ=WEEKLY;COUNT=3'))
    const invited = t.cal.inviteFor(t.msgId)!.event.id
    expect(t.cal.exportIcs(invited).content).not.toMatch(/RRULE/)
  })
})
