import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CalendarDays, Check, CircleHelp, Download, MapPin, Repeat, TriangleAlert, Users, Video, X } from 'lucide-react'
import type { CalendarResponse, Invite } from '@imc/core'

const errText = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
const shortTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

/** "Wednesday, November 4, 2026 · 2:00 – 3:00 PM EST" in the viewer's own time zone. */
export function whenText(start: number, end: number, allDay: boolean): string {
  const s = new Date(start)
  const e = new Date(end)
  if (allDay) return dayFmt.format(s)
  const sameDay = s.toDateString() === e.toDateString()
  return sameDay
    ? `${dayFmt.format(s)} · ${shortTime.format(s)} – ${timeFmt.format(e)}`
    : `${dayFmt.format(s)} ${shortTime.format(s)} – ${dayFmt.format(e)} ${timeFmt.format(e)}`
}

const btn =
  'flex h-8 items-center gap-1.5 rounded-md border border-line-strong px-3 text-sm text-ink transition-colors duration-(--dur-fast) hover:bg-hover disabled:opacity-50'

export const RESPONSE_LABEL: Record<CalendarResponse, string> = {
  accepted: 'Accepted',
  tentative: 'Tentative',
  declined: 'Declined'
}

const PARTSTAT_LABEL: Record<string, string> = {
  ACCEPTED: 'Accepted',
  TENTATIVE: 'Tentative',
  DECLINED: 'Declined',
  'NEEDS-ACTION': 'No answer'
}

/**
 * The meeting a message carries, with Accept / Tentative / Decline. Answers go back to the
 * organizer as a standard calendar reply that Outlook, Exchange and Google Calendar understand.
 */
export default function InviteCard({ messageId, invite }: { messageId: string; invite: Invite }) {
  const qc = useQueryClient()
  const { event: e, method, conflicts, outdated } = invite
  const [comment, setComment] = useState('')
  const [commenting, setCommenting] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const cancelled = e.status === 'CANCELLED' || method === 'CANCEL'
  const canAnswer = !cancelled && !outdated && !e.mine && method !== 'PUBLISH'

  const respond = useMutation({
    mutationFn: (response: CalendarResponse) =>
      window.imc.invoke('calendar:respond', { messageId, response, comment: comment.trim() || undefined }),
    onSuccess: () => {
      setCommenting(false)
      setComment('')
      void qc.invalidateQueries()
    }
  })
  const exportIcs = useMutation({
    mutationFn: () => window.imc.invoke('calendar:exportIcs', { id: e.id }),
    onSuccess: (r) => setSaved(r.saved)
  })

  const answer = (r: CalendarResponse, Icon: typeof Check, label: string) => (
    <button
      type="button"
      className={`${btn} ${e.myResponse === r ? 'bg-selected font-medium' : ''}`}
      aria-pressed={e.myResponse === r}
      disabled={respond.isPending}
      onClick={() => respond.mutate(r)}
    >
      <Icon size={14} strokeWidth={1.75} aria-hidden />
      {label}
    </button>
  )

  return (
    <section aria-label="Meeting invitation" className="space-y-3 rounded-md border border-line-strong p-4">
      <div className="flex items-start gap-3">
        <CalendarDays size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-ink-2" aria-hidden />
        <div className="min-w-0 flex-1">
          <h3 className={`text-md font-semibold ${cancelled ? 'line-through' : ''}`}>{e.summary || '(no title)'}</h3>
          <p className="num text-ink-2">{whenText(e.start, e.end, e.allDay)}</p>
        </div>
        {cancelled && (
          <span className="shrink-0 rounded-sm border border-alert px-1.5 text-xs leading-4 text-alert">Cancelled</span>
        )}
        {!cancelled && e.mine && (
          <span className="shrink-0 rounded-sm border border-line-strong px-1.5 text-xs leading-4 text-ink-2">
            You organize this
          </span>
        )}
      </div>

      {outdated && !cancelled && (
        <p role="status" className="flex items-start gap-2 text-sm text-ink-2">
          <TriangleAlert size={14} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden />
          The organizer sent a newer version of this meeting. Open the latest message to answer.
        </p>
      )}

      <dl className="space-y-1.5 text-sm">
        {e.repeats && (
          <div className="flex items-start gap-2">
            <dt className="sr-only">Repeats</dt>
            <Repeat size={14} strokeWidth={1.75} className="mt-0.5 shrink-0 text-ink-3" aria-hidden />
            <dd className="text-ink-2">{e.repeats}</dd>
          </div>
        )}
        {e.location && (
          <div className="flex items-start gap-2">
            <dt className="sr-only">Where</dt>
            <MapPin size={14} strokeWidth={1.75} className="mt-0.5 shrink-0 text-ink-3" aria-hidden />
            <dd className="min-w-0 break-words text-ink-2">{e.location}</dd>
          </div>
        )}
        {e.organizer && (
          <div className="flex items-start gap-2">
            <dt className="sr-only">Organizer</dt>
            <Users size={14} strokeWidth={1.75} className="mt-0.5 shrink-0 text-ink-3" aria-hidden />
            <dd className="min-w-0 break-words text-ink-2">
              {e.organizer.name || e.organizer.email}
              {e.organizer.name && <span className="text-ink-3"> · {e.organizer.email}</span>}
            </dd>
          </div>
        )}
      </dl>

      {e.attendees.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-ink-2 hover:text-ink">
            {e.attendees.length} {e.attendees.length === 1 ? 'attendee' : 'attendees'}
          </summary>
          <ul className="mt-1.5 space-y-0.5 pl-1">
            {e.attendees.map((a) => (
              <li key={a.email} className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-ink-2">{a.name || a.email}</span>
                <span className="shrink-0 text-ink-3">{PARTSTAT_LABEL[a.partstat] ?? a.partstat}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {conflicts.length > 0 && !cancelled && (
        <p role="status" className="flex items-start gap-2 rounded-md border border-line-strong px-3 py-2 text-sm text-ink-2">
          <TriangleAlert size={14} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            Overlaps with{' '}
            {conflicts.map((c) => `${c.summary || 'another meeting'} (${shortTime.format(c.start)})`).join(', ')}.
          </span>
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {e.onlineUrl && !cancelled && (
          <a
            href={e.onlineUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-on-accent transition-colors duration-(--dur-fast) hover:bg-accent-hover"
          >
            <Video size={14} strokeWidth={1.75} aria-hidden />
            Join online
          </a>
        )}
        {canAnswer && (
          <>
            {answer('accepted', Check, 'Accept')}
            {answer('tentative', CircleHelp, 'Tentative')}
            {answer('declined', X, 'Decline')}
            <button type="button" className="text-sm text-ink-2 underline hover:text-ink" onClick={() => setCommenting((v) => !v)}>
              {commenting ? 'No message' : 'Add a message'}
            </button>
          </>
        )}
        <button type="button" className={`${btn} ml-auto`} onClick={() => exportIcs.mutate()} disabled={exportIcs.isPending}>
          <Download size={14} strokeWidth={1.75} aria-hidden />
          Add to calendar (.ics)
        </button>
      </div>

      {commenting && canAnswer && (
        <label className="block text-sm text-ink-2">
          Message to the organizer, sent with your answer
          <textarea
            value={comment}
            maxLength={1000}
            rows={2}
            onChange={(ev) => setComment(ev.target.value)}
            className="mt-1 block w-full rounded-md border border-line-strong bg-sheet px-2 py-1.5 text-ink"
          />
        </label>
      )}

      {e.myResponse && canAnswer && (
        <p role="status" className="text-sm text-ink-2">
          You answered <strong className="font-medium text-ink">{RESPONSE_LABEL[e.myResponse]}</strong>. The organizer has been emailed.
        </p>
      )}
      {saved && <p className="text-sm text-ink-3">Saved to {saved}</p>}
      {(respond.isError || exportIcs.isError) && (
        <p role="alert" className="text-sm text-alert">
          {errText(respond.error ?? exportIcs.error)}
        </p>
      )}
    </section>
  )
}
