import { randomUUID } from 'node:crypto'
import {
  buildICS,
  buildReply,
  describeRecurrence,
  escapeHtml,
  occurrences,
  replySubject,
  safeWebUrl,
  type CalEvent,
  type CalendarEvent,
  type CalendarOccurrence,
  type CalendarResponse,
  type Draft,
  type Invite,
  type MeetingInput,
  type ReplyStatus
} from '@imc/core'
import { bareAddress } from './compose'
import type { AccountRow, MailStore, StoredEvent, StoredRemoteEvent } from './store'

const HOUR = 3600e3
const DAY = 24 * HOUR

const STATUS_OF: Record<CalendarResponse, ReplyStatus> = {
  accepted: 'ACCEPTED',
  tentative: 'TENTATIVE',
  declined: 'DECLINED'
}
const RESPONSE_OF: Record<string, CalendarResponse | undefined> = {
  ACCEPTED: 'accepted',
  TENTATIVE: 'tentative',
  DECLINED: 'declined'
}

const esc = escapeHtml

/** "Wed, Nov 4, 2026, 2:00 PM EST" in the machine's zone. */
export function describeWhen(start: number, end: number, allDay: boolean): string {
  if (allDay) {
    const f = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
    const last = end - DAY > start ? f.format(new Date(end - DAY)) : null
    return last ? `${f.format(new Date(start))} to ${last} (all day)` : `${f.format(new Date(start))} (all day)`
  }
  const day = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })
  const zone = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(new Date(start)).find((p) => p.type === 'timeZoneName')?.value ?? ''
  return `${day.format(new Date(start))}, ${time.format(new Date(start))} to ${time.format(new Date(end))} ${zone}`.trim()
}

/** Meetings: invitations you receive and answer, and meetings you organize. */
export class CalendarService {
  constructor(
    private store: MailStore,
    private mail: { send(draft: Draft, opts?: { immediate?: boolean }): Promise<unknown> },
    private now: () => number = Date.now,
    /** The IANA zone repeating meetings are written in (the computer's own by default). */
    private zone: string = Intl.DateTimeFormat().resolvedOptions().timeZone
  ) {}

  private own(): AccountRow[] {
    return this.store.listAccounts()
  }

  private ownEmails(): Set<string> {
    return new Set(this.own().map((a) => a.email.toLowerCase()))
  }

  private pub(e: StoredEvent, messageId: string | null = null): CalendarEvent {
    const { exdates: _x, free: _f, updatedAt: _u, ...rest } = e
    return { ...rest, repeats: describeRecurrence(e.rrule), messageId, readOnly: false }
  }

  private pubRemote(r: StoredRemoteEvent): CalendarEvent {
    return {
      id: r.id,
      accountId: r.accountId,
      uid: r.uid,
      sequence: 0,
      recurrenceId: null,
      summary: r.summary,
      description: r.description,
      location: r.location,
      start: r.start,
      end: r.end,
      allDay: r.allDay,
      rrule: null,
      repeats: null,
      organizer: r.organizer,
      attendees: r.attendees.map((a) => ({ name: a.name, email: a.email, partstat: a.partstat, role: 'REQ-PARTICIPANT', rsvp: false })),
      status: r.status,
      onlineUrl: r.onlineUrl,
      myResponse: r.myResponse,
      mine: r.mine,
      messageId: null,
      readOnly: true
    }
  }

  private idOf(accountId: string, uid: string, recurrenceId: number | null): string {
    return `${accountId}:${uid}:${recurrenceId ?? ''}`
  }

  // ---- incoming invitations ----------------------------------------------------------

  /** Records the meetings found in a downloaded message. */
  ingest(accountId: string, messageId: string, events: CalEvent[]): void {
    const mine = this.ownEmails()
    for (const ev of events) {
      const id = this.idOf(accountId, ev.uid, ev.recurrenceId)
      const existing = this.store.getEvent(id)
      const method = ev.method ?? 'PUBLISH'

      if (method === 'REPLY') {
        // An attendee answered a meeting you organize: show their answer.
        if (existing?.mine) {
          const attendees = existing.attendees.map((a) => {
            const reply = ev.attendees.find((r) => r.email === a.email)
            return reply ? { ...a, partstat: reply.partstat } : a
          })
          this.store.putEvent({ ...existing, attendees, updatedAt: this.now() })
        }
        continue
      }

      if (existing && existing.sequence > ev.sequence && method !== 'CANCEL') {
        // An older version arriving late: remember the message, change nothing.
        this.store.linkEventMessage(messageId, id, method, ev.sequence)
        continue
      }

      const iOrganize = !!ev.organizer && mine.has(ev.organizer.email)
      const sameTime = existing && existing.start === ev.start && existing.end === ev.end && existing.rrule === ev.rrule
      // If Outlook already knew your answer (the attendee line says so), take it.
      const declared = ev.attendees.find((a) => mine.has(a.email) && RESPONSE_OF[a.partstat])
      const myResponse: CalendarResponse | null = iOrganize
        ? null
        : sameTime
          ? (existing!.myResponse ?? (declared ? (RESPONSE_OF[declared.partstat] ?? null) : null))
          : declared
            ? (RESPONSE_OF[declared.partstat] ?? null)
            : null

      const stored: StoredEvent = {
        id,
        accountId,
        uid: ev.uid,
        sequence: Math.max(ev.sequence, existing?.sequence ?? 0),
        recurrenceId: ev.recurrenceId,
        summary: ev.summary || existing?.summary || '(no title)',
        description: ev.description,
        location: ev.location,
        start: ev.start,
        end: ev.end,
        allDay: ev.allDay,
        rrule: ev.rrule,
        repeats: null,
        exdates: ev.exdates,
        organizer: ev.organizer,
        attendees: ev.attendees,
        status: method === 'CANCEL' ? 'CANCELLED' : ev.status,
        onlineUrl: ev.onlineUrl,
        free: ev.free,
        myResponse: method === 'CANCEL' ? (existing?.myResponse ?? null) : myResponse,
        mine: iOrganize,
        messageId: null,
        updatedAt: this.now()
      }
      this.store.putEvent(stored)
      this.store.linkEventMessage(messageId, id, method, ev.sequence)
    }
  }

  /** The invitation shown on a message, with clashes and whether a newer version exists. */
  inviteFor(messageId: string): Invite | null {
    const links = this.store.eventsForMessage(messageId)
    if (links.length === 0) return null
    const first = links.find((l) => l.method !== 'REPLY')
    if (!first) return null
    const e = first.event
    return {
      event: this.pub(e, messageId),
      method: first.method,
      conflicts: this.conflictsFor(e),
      outdated: first.sequence < e.sequence
    }
  }

  private conflictsFor(e: StoredEvent): { summary: string; start: number; end: number }[] {
    if (e.status === 'CANCELLED' || e.free) return []
    const busy = this.store
      .eventsInRange(e.start - DAY, e.end + DAY)
      .filter((o) => o.uid !== e.uid && !o.free && (o.mine || o.myResponse === 'accepted' || o.myResponse === 'tentative'))
    const out: { summary: string; start: number; end: number }[] = []
    for (const o of busy) {
      const len = o.end - o.start
      for (const t of occurrences(this.asCal(o), e.start - len, e.end + 1, 20)) {
        if (t < e.end && t + len > e.start) out.push({ summary: o.summary, start: t, end: t + len })
      }
    }
    // Meetings in the account's own calendar block time too.
    for (const r of this.store.remoteEventsInRange(e.start - DAY, e.end + DAY)) {
      if (r.uid !== e.uid && !r.free && r.start < e.end && r.end > e.start) out.push({ summary: r.summary, start: r.start, end: r.end })
    }
    return out.sort((a, b) => a.start - b.start).slice(0, 5)
  }

  private asCal(e: StoredEvent): CalEvent {
    return {
      method: null,
      uid: e.uid,
      sequence: e.sequence,
      recurrenceId: e.recurrenceId,
      summary: e.summary,
      description: e.description,
      location: e.location,
      start: e.start,
      end: e.end,
      allDay: e.allDay,
      rrule: e.rrule,
      exdates: e.exdates,
      organizer: e.organizer,
      attendees: e.attendees,
      status: e.status,
      onlineUrl: e.onlineUrl,
      dtstamp: null,
      free: e.free
    }
  }

  /** Who "you" are on an invitation: the invited address that is one of your accounts. */
  private me(e: StoredEvent, messageAccountId: string): { name: string; email: string } {
    const accounts = this.own()
    const invited = e.attendees.find((a) => accounts.some((acc) => acc.email.toLowerCase() === a.email))
    if (invited) {
      const acc = accounts.find((x) => x.email.toLowerCase() === invited.email)!
      return { name: invited.name || acc.displayName, email: invited.email }
    }
    const acc = accounts.find((a) => a.id === messageAccountId) ?? accounts[0]!
    return { name: acc.displayName, email: acc.email } // sent to an alias or a list
  }

  /** Answers an invitation: records it and emails the organizer a reply Outlook understands. */
  async respond(messageId: string, response: CalendarResponse, comment?: string): Promise<CalendarEvent> {
    const link = this.store.eventsForMessage(messageId).find((l) => l.method !== 'REPLY')
    if (!link) throw new Error('This message has no meeting invitation')
    const e = link.event
    if (e.mine) throw new Error('You organized this meeting, so there is nothing to reply to')
    if (e.status === 'CANCELLED') throw new Error('This meeting was cancelled')
    if (!e.organizer) throw new Error('This invitation does not say who organized it')

    const msg = this.store.getMessage(messageId)
    const me = this.me(e, msg?.accountId ?? e.accountId)
    const ics = buildReply(this.asCal(e), me, STATUS_OF[response], comment, this.now())
    const verb = response === 'accepted' ? 'accepted' : response === 'tentative' ? 'tentatively accepted' : 'declined'
    const text = `${me.name || me.email} has ${verb} this meeting${comment ? `:\n\n${comment}` : '.'}`
    const draft: Draft = {
      accountId: msg?.accountId ?? e.accountId,
      to: [e.organizer.email],
      cc: [],
      bcc: [],
      subject: replySubject(STATUS_OF[response], e.summary),
      html: `<p>${esc(text).replace(/\n/g, '<br>')}</p>`,
      inReplyTo: this.store.getReplyHeaders(messageId)?.messageId ?? undefined,
      attachments: [],
      ical: { method: 'REPLY', content: ics }
    }
    await this.mail.send(draft, { immediate: true })
    this.store.putEvent({ ...e, myResponse: response, updatedAt: this.now() })
    return this.pub(this.store.getEvent(e.id)!, messageId)
  }

  // ---- your own meetings ---------------------------------------------------------------

  list(from: number, to: number): CalendarOccurrence[] {
    const out: CalendarOccurrence[] = []
    for (const e of this.store.eventsInRange(from, to)) {
      const len = e.end - e.start
      const pub = this.pub(e, this.store.messageForEvent(e.id))
      for (const t of occurrences(this.asCal(e), from, to, 100)) out.push({ event: pub, start: t, end: t + len })
    }
    // Meetings from the account's own calendar, except the ones that also came by email (those are shown above).
    const known = new Set(this.store.eventsInRange(from, to).map((e) => `${e.accountId}|${e.uid}`))
    for (const r of this.store.remoteEventsInRange(from, to)) {
      if (known.has(`${r.accountId}|${r.uid}`)) continue
      out.push({ event: this.pubRemote(r), start: r.start, end: r.end })
    }
    return out.sort((a, b) => a.start - b.start)
  }

  private attendeesOf(raw: string[]): { name: string; email: string }[] {
    const seen = new Set<string>()
    const out: { name: string; email: string }[] = []
    for (const r of raw) {
      const email = bareAddress(r)
      if (!email) throw new Error(`"${r}" is not a valid email address`)
      if (seen.has(email.toLowerCase())) continue
      seen.add(email.toLowerCase())
      const m = /^\s*"?([^"<]*?)"?\s*</.exec(r)
      out.push({ name: m?.[1]?.trim() ?? '', email: email.toLowerCase() })
    }
    return out
  }

  private async sendInvitation(
    e: StoredEvent,
    method: 'REQUEST' | 'CANCEL',
    subjectPrefix: string,
    note: string
  ): Promise<void> {
    const account = this.own().find((a) => a.id === e.accountId)
    if (!account) throw new Error('The account for this meeting is gone')
    const organizer = { name: account.displayName, email: account.email }
    const ics = buildICS(
      method,
      {
        uid: e.uid,
        sequence: e.sequence,
        summary: e.summary,
        description: e.description,
        location: e.location,
        start: e.start,
        end: e.end,
        allDay: e.allDay,
        rrule: e.rrule,
        zone: e.rrule ? this.zone : undefined,
        organizer,
        attendees: e.attendees.map((a) => ({ name: a.name, email: a.email, partstat: a.partstat, role: a.role, rsvp: true })),
        onlineUrl: e.onlineUrl
      },
      this.now()
    )
    const lines = [
      `<p>${esc(note)}</p>`,
      `<p><b>${esc(e.summary)}</b></p>`,
      `<p>When: ${esc(describeWhen(e.start, e.end, e.allDay))}</p>`,
      e.repeats ? `<p>Repeats: ${esc(e.repeats)}</p>` : '',
      e.location ? `<p>Where: ${esc(e.location)}</p>` : '',
      safeWebUrl(e.onlineUrl) ? `<p>Join: <a href="${esc(e.onlineUrl!)}">${esc(e.onlineUrl!)}</a></p>` : '',
      e.description ? `<p>${esc(e.description).replace(/\n/g, '<br>')}</p>` : ''
    ]
    await this.mail.send({
      accountId: e.accountId,
      to: e.attendees.map((a) => (a.name ? `${a.name.replace(/["<>]/g, '')} <${a.email}>` : a.email)),
      cc: [],
      bcc: [],
      subject: `${subjectPrefix}${e.summary}`,
      html: lines.join(''),
      attachments: [],
      ical: { method, content: ics }
    })
  }

  /** Creates a meeting and emails the invitation. Times are sent in UTC, which Outlook shows in the reader's zone. */
  async schedule(input: MeetingInput): Promise<CalendarEvent> {
    const rrule = ruleFor(input.repeat, input.repeatCount)
    const account = this.own().find((a) => a.id === input.accountId)
    if (!account) throw new Error('Choose an account to organize from')
    if (input.end <= input.start) throw new Error('The meeting must end after it starts')
    const people = this.attendeesOf(input.attendees).filter((a) => a.email !== account.email.toLowerCase())
    if (people.length === 0) throw new Error('Add at least one attendee besides yourself')

    const domain = account.email.slice(account.email.lastIndexOf('@') + 1)
    const uid = `${randomUUID()}@${domain}`
    const e: StoredEvent = {
      id: this.idOf(account.id, uid, null),
      accountId: account.id,
      uid,
      sequence: 0,
      recurrenceId: null,
      summary: input.summary,
      description: input.description ?? '',
      location: input.location ?? '',
      start: input.start,
      end: input.end,
      allDay: input.allDay ?? false,
      rrule,
      repeats: describeRecurrence(rrule),
      exdates: [],
      organizer: { name: account.displayName, email: account.email.toLowerCase() },
      attendees: people.map((p) => ({ ...p, partstat: 'NEEDS-ACTION', role: 'REQ-PARTICIPANT', rsvp: true })),
      status: 'CONFIRMED',
      onlineUrl: input.onlineUrl ?? null,
      free: false,
      myResponse: null,
      mine: true,
      messageId: null,
      updatedAt: this.now()
    }
    await this.sendInvitation(e, 'REQUEST', '', `${account.displayName || account.email} invited you to a meeting.`)
    this.store.putEvent(e)
    return this.pub(e)
  }

  async update(id: string, patch: Partial<Omit<MeetingInput, 'accountId'>>): Promise<CalendarEvent> {
    const e = this.store.getEvent(id)
    if (!e) throw new Error('That meeting no longer exists')
    if (!e.mine) throw new Error('Only the organizer can change a meeting')
    if (e.status === 'CANCELLED') throw new Error('This meeting was cancelled')
    const start = patch.start ?? e.start
    const end = patch.end ?? e.end
    if (end <= start) throw new Error('The meeting must end after it starts')
    const rrule = patch.repeat === undefined ? e.rrule : ruleFor(patch.repeat, patch.repeatCount)
    const moved = start !== e.start || end !== e.end || rrule !== e.rrule
    const wanted = patch.attendees ? this.attendeesOf(patch.attendees) : null
    const attendees = wanted
      ? wanted.map((w) => e.attendees.find((a) => a.email === w.email) ?? { ...w, partstat: 'NEEDS-ACTION', role: 'REQ-PARTICIPANT', rsvp: true })
      : e.attendees
    const next: StoredEvent = {
      ...e,
      summary: patch.summary ?? e.summary,
      description: patch.description ?? e.description,
      location: patch.location ?? e.location,
      onlineUrl: patch.onlineUrl === undefined ? e.onlineUrl : patch.onlineUrl,
      allDay: patch.allDay ?? e.allDay,
      rrule,
      repeats: describeRecurrence(rrule),
      start,
      end,
      sequence: e.sequence + 1,
      // A new time asks everyone to answer again, as Outlook does.
      attendees: moved ? attendees.map((a) => ({ ...a, partstat: 'NEEDS-ACTION' })) : attendees,
      updatedAt: this.now()
    }
    await this.sendInvitation(next, 'REQUEST', 'Updated: ', 'This meeting has been updated.')
    this.store.putEvent(next)
    return this.pub(next)
  }

  async cancel(id: string): Promise<CalendarEvent> {
    const e = this.store.getEvent(id)
    if (!e) throw new Error('That meeting no longer exists')
    if (!e.mine) throw new Error('Only the organizer can cancel a meeting')
    const next: StoredEvent = { ...e, sequence: e.sequence + 1, status: 'CANCELLED', updatedAt: this.now() }
    await this.sendInvitation(next, 'CANCEL', 'Canceled: ', 'This meeting has been canceled.')
    this.store.putEvent(next)
    return this.pub(next)
  }

  /** The meeting as an .ics file, for Outlook, Apple Calendar, or anything else. */
  exportIcs(id: string): { filename: string; content: string } {
    const e = this.store.getEvent(id)
    if (!e) throw new Error('That meeting no longer exists')
    const org = e.organizer ?? { name: '', email: this.own()[0]?.email ?? 'unknown@invalid' }
    const content = buildICS(
      e.status === 'CANCELLED' ? 'CANCEL' : 'PUBLISH',
      {
        uid: e.uid,
        sequence: e.sequence,
        summary: e.summary,
        description: e.description,
        location: e.location,
        start: e.start,
        end: e.end,
        allDay: e.allDay,
        organizer: org,
        attendees: e.attendees.map((a) => ({ name: a.name, email: a.email, partstat: a.partstat, role: a.role, rsvp: false })),
        status: e.status,
        // A series you organize keeps its repeat rule and time zone; one you were invited to is
        // exported as its first occurrence, because its original zone is not kept.
        rrule: e.mine ? e.rrule : null,
        zone: e.mine && e.rrule ? this.zone : undefined,
        onlineUrl: e.onlineUrl
      },
      this.now()
    )
    const safe = e.summary.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 60) || 'meeting'
    return { filename: `${safe}.ics`, content }
  }
}

/** The repeat rule for a choice in the meeting dialog, or null for a single meeting. */
export function ruleFor(repeat: MeetingInput['repeat'], count: number | undefined): string | null {
  if (!repeat || repeat === 'none') return null
  const n = Math.min(200, Math.max(2, Math.floor(count ?? 10)))
  const freq = repeat === 'daily' ? 'FREQ=DAILY' : repeat === 'weekly' ? 'FREQ=WEEKLY' : repeat === 'biweekly' ? 'FREQ=WEEKLY;INTERVAL=2' : 'FREQ=MONTHLY'
  return `${freq};COUNT=${n}`
}
