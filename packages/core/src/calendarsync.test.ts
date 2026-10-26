import { describe, expect, it } from 'vitest'
import { googleEventsUrl, googleNextPage, graphEventsUrl, graphNextLink, parseGoogleEvents, parseGraphEvents } from './calendarsync'

const graph = (over: Record<string, unknown> = {}) => ({
  id: 'AAMk1',
  iCalUId: '040000008200E00074C5B7101A82E008',
  subject: 'Sponsor call',
  bodyPreview: 'Agenda inside',
  start: { dateTime: '2026-11-04T19:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-11-04T20:00:00.0000000', timeZone: 'UTC' },
  isAllDay: false,
  isCancelled: false,
  isOrganizer: false,
  showAs: 'busy',
  location: { displayName: 'Room 4' },
  onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' },
  organizer: { emailAddress: { name: 'Pat Lee', address: 'Pat@Nova.example' } },
  responseStatus: { response: 'accepted' },
  attendees: [{ emailAddress: { name: 'Casey', address: 'casey@me.example' }, status: { response: 'accepted' } }],
  ...over
})

describe('Microsoft Graph events', () => {
  it('reads a meeting, with its time in UTC', () => {
    const [e] = parseGraphEvents({ value: [graph()] })
    expect(e).toMatchObject({
      remoteId: 'AAMk1',
      uid: '040000008200E00074C5B7101A82E008',
      summary: 'Sponsor call',
      location: 'Room 4',
      start: Date.UTC(2026, 10, 4, 19),
      end: Date.UTC(2026, 10, 4, 20),
      allDay: false,
      status: 'CONFIRMED',
      onlineUrl: 'https://teams.microsoft.com/l/meetup-join/abc',
      organizer: { name: 'Pat Lee', email: 'pat@nova.example' },
      myResponse: 'accepted',
      mine: false,
      free: false
    })
    expect(e!.attendees).toEqual([{ name: 'Casey', email: 'casey@me.example', partstat: 'ACCEPTED' }])
  })

  it('keeps an all-day event on its own calendar day', () => {
    const [e] = parseGraphEvents({
      value: [graph({ isAllDay: true, start: { dateTime: '2026-12-24T00:00:00.0000000' }, end: { dateTime: '2026-12-25T00:00:00.0000000' } })]
    })
    expect(e).toMatchObject({ allDay: true, start: new Date(2026, 11, 24).getTime(), end: new Date(2026, 11, 25).getTime() })
  })

  it('leaves out cancelled and declined meetings, and anything without a time', () => {
    const list = parseGraphEvents({
      value: [graph({ isCancelled: true }), graph({ id: 'b', responseStatus: { response: 'declined' } }), graph({ id: 'c', start: {} }), graph({ id: 'd' })]
    })
    expect(list.map((e) => e.remoteId)).toEqual(['d'])
  })

  it('maps tentative, free and organizer', () => {
    const [e] = parseGraphEvents({ value: [graph({ showAs: 'free', isOrganizer: true, responseStatus: { response: 'tentativelyAccepted' } })] })
    expect(e).toMatchObject({ free: true, mine: true, myResponse: 'tentative' })
    expect(parseGraphEvents({ value: [graph({ showAs: 'tentative' })] })[0]!.status).toBe('TENTATIVE')
  })

  it('does not trust the meeting link or the shape of the answer', () => {
    const [e] = parseGraphEvents({ value: [graph({ onlineMeeting: { joinUrl: 'javascript:alert(1)' }, location: { displayName: 'plain room' } })] })
    expect(e!.onlineUrl).toBeNull()
    expect(parseGraphEvents(null)).toEqual([])
    expect(parseGraphEvents({ value: 'nope' })).toEqual([])
    expect(parseGraphEvents({ value: [null, 5, 'x'] })).toEqual([])
  })

  it('caps long text and long attendee lists', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ emailAddress: { address: `p${i}@x.example` }, status: {} }))
    const [e] = parseGraphEvents({ value: [graph({ subject: 'x'.repeat(5000), attendees: many })] })
    expect(e!.summary).toHaveLength(500)
    expect(e!.attendees).toHaveLength(50)
  })

  it('follows next links only when they stay on Graph', () => {
    expect(graphNextLink({ '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendarView?$skip=200' })).toContain('$skip=200')
    expect(graphNextLink({ '@odata.nextLink': 'https://evil.example/steal' })).toBeNull()
    expect(graphNextLink({})).toBeNull()
  })

  it('asks for the window it was given', () => {
    const url = new URL(graphEventsUrl(Date.UTC(2026, 10, 1), Date.UTC(2027, 2, 1)))
    expect(url.origin + url.pathname).toBe('https://graph.microsoft.com/v1.0/me/calendarView')
    expect(url.searchParams.get('startDateTime')).toBe('2026-11-01T00:00:00.000Z')
    expect(url.searchParams.get('endDateTime')).toBe('2027-03-01T00:00:00.000Z')
  })
})

const google = (over: Record<string, unknown> = {}) => ({
  id: 'g1',
  iCalUID: 'g1@google.com',
  summary: 'Collab sync',
  description: 'Notes',
  location: 'Studio',
  status: 'confirmed',
  start: { dateTime: '2026-11-04T14:00:00-05:00' },
  end: { dateTime: '2026-11-04T15:00:00-05:00' },
  hangoutLink: 'https://meet.google.com/abc-defg-hij',
  organizer: { email: 'Me@Gmail.com', displayName: 'Me', self: true },
  attendees: [
    { email: 'me@gmail.com', self: true, responseStatus: 'accepted' },
    { email: 'sam@x.example', displayName: 'Sam', responseStatus: 'needsAction' }
  ],
  ...over
})

describe('Google Calendar events', () => {
  it('reads a meeting, keeping the real moment from the offset', () => {
    const [e] = parseGoogleEvents({ items: [google()] })
    expect(e).toMatchObject({
      remoteId: 'g1',
      uid: 'g1@google.com',
      start: Date.UTC(2026, 10, 4, 19),
      end: Date.UTC(2026, 10, 4, 20),
      onlineUrl: 'https://meet.google.com/abc-defg-hij',
      organizer: { name: 'Me', email: 'me@gmail.com' },
      myResponse: 'accepted',
      mine: true,
      free: false
    })
    expect(e!.attendees[1]).toEqual({ name: 'Sam', email: 'sam@x.example', partstat: 'NEEDS-ACTION' })
  })

  it('uses the video entry point when there is no Meet link, and all-day dates', () => {
    const [e] = parseGoogleEvents({
      items: [
        google({
          hangoutLink: undefined,
          conferenceData: { entryPoints: [{ entryPointType: 'phone', uri: 'tel:+1' }, { entryPointType: 'video', uri: 'https://zoom.us/j/123' }] },
          start: { date: '2026-12-24' },
          end: { date: '2026-12-25' },
          transparency: 'transparent'
        })
      ]
    })
    expect(e).toMatchObject({ onlineUrl: 'https://zoom.us/j/123', allDay: true, start: new Date(2026, 11, 24).getTime(), free: true })
  })

  it('leaves out cancelled and declined events', () => {
    const list = parseGoogleEvents({
      items: [google({ status: 'cancelled' }), google({ id: 'b', attendees: [{ self: true, responseStatus: 'declined', email: 'me@gmail.com' }] }), google({ id: 'c' })]
    })
    expect(list.map((e) => e.remoteId)).toEqual(['c'])
  })

  it('is safe on odd answers, and builds page requests', () => {
    expect(parseGoogleEvents(undefined)).toEqual([])
    expect(parseGoogleEvents({ items: [{ id: 'x' }, 7] })).toEqual([])
    expect(googleNextPage({ nextPageToken: 'abc' })).toBe('abc')
    expect(googleNextPage({})).toBeNull()
    const url = new URL(googleEventsUrl(0, 1000, 'tok'))
    expect(url.pathname).toBe('/calendar/v3/calendars/primary/events')
    expect(url.searchParams.get('singleEvents')).toBe('true')
    expect(url.searchParams.get('pageToken')).toBe('tok')
  })
})
