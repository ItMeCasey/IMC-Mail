import { askConfirm } from './dialogs'
import { useEffect, useRef, useState } from 'react'
import { Download, Mail } from 'lucide-react'
import { safeWebUrl, type Account, type CalendarEvent } from '@imc/core'
import { whenText } from './InviteCard'
import RecipientInput, { isValidRecipient } from './RecipientInput'
import { fromLocalInput, toLocalInput } from './schedule'

const errText = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const field =
  'mt-1 block h-9 w-full rounded-md border border-line-strong bg-sheet px-2.5 text-ink'
const btn = 'h-9 rounded-md border border-line-strong px-4 text-ink hover:bg-hover disabled:opacity-50'

/** The next half hour, so a new meeting starts with a sensible time. */
const nextSlot = () => {
  const d = new Date()
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0)
  return d.getTime()
}

/**
 * Schedules a meeting (sent as a standard invitation that Outlook shows with Accept / Decline),
 * or shows one you were invited to. Meetings you organize can be changed or cancelled here, and
 * the attendees are emailed the update.
 */
export default function MeetingDialog({
  accounts,
  event,
  initialStart = null,
  onOpenMessage,
  onClose,
  onChanged
}: {
  accounts: Account[]
  event: CalendarEvent | null
  /** For a new meeting: a start picked from the calendar, instead of the next half hour. */
  initialStart?: number | null
  onOpenMessage: (id: string) => void
  onClose: () => void
  onChanged: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  const editable = event === null || (event.mine && !event.readOnly)
  const start0 = event?.start ?? initialStart ?? nextSlot()
  const [summary, setSummary] = useState(event?.summary ?? '')
  const [accountId, setAccountId] = useState(event?.accountId ?? accounts[0]?.id ?? '')
  const [start, setStart] = useState(toLocalInput(start0))
  const [end, setEnd] = useState(toLocalInput(event?.end ?? start0 + 30 * 60_000))
  const [location, setLocation] = useState(event?.location ?? '')
  const [onlineUrl, setOnlineUrl] = useState(event?.onlineUrl ?? '')
  const [description, setDescription] = useState(event?.description ?? '')
  const [attendees, setAttendees] = useState<string[]>(
    event?.attendees.map((a) => (a.name ? `${a.name.replace(/["<>]/g, '')} <${a.email}>` : a.email)) ?? []
  )
  const [allDay, setAllDay] = useState(event?.allDay ?? false)
  const [repeat, setRepeat] = useState<'none' | 'daily' | 'weekly' | 'biweekly' | 'monthly'>(
    event?.rrule ? 'none' : 'none'
  )
  const [repeatCount, setRepeatCount] = useState(10)
  const [changedRepeat, setChangedRepeat] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  // Moving the start keeps the length, as calendars do.
  const moveStart = (v: string) => {
    const a = fromLocalInput(start)
    const b = fromLocalInput(end)
    const n = fromLocalInput(v)
    setStart(v)
    if (a !== null && b !== null && n !== null && b > a) setEnd(toLocalInput(n + (b - a)))
  }

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      onChanged()
      dialog.current?.close()
    } catch (e) {
      setError(errText(e))
      setBusy(false)
    }
  }

  const save = () => {
    // All-day meetings are whole local days; the end date is the last day, sent as the day after.
    const day = (v: string) => fromLocalInput(`${v.slice(0, 10)}T00:00`)
    const s = allDay ? day(start) : fromLocalInput(start)
    const e = allDay ? (day(end) === null ? null : new Date(new Date(day(end)!).setDate(new Date(day(end)!).getDate() + 1)).getTime()) : fromLocalInput(end)
    if (!summary.trim()) return setError('Give the meeting a title.')
    if (s === null || e === null || e <= s) return setError('The meeting has to end after it starts.')
    if (attendees.length === 0) return setError('Add at least one attendee to send the invitation to.')
    if (!attendees.every(isValidRecipient)) return setError('One of the attendees is not a valid email address.')
    const body = {
      summary: summary.trim(),
      location: location.trim(),
      description,
      start: s,
      end: e,
      attendees,
      allDay,
      onlineUrl: onlineUrl.trim() || null,
      // On an edit, leaving the repeat alone keeps the series as it is.
      ...(event === null || repeat !== 'none' || changedRepeat ? { repeat, repeatCount } : {})
    }
    void run(() =>
      event ? window.imc.invoke('calendar:update', { id: event.id, patch: body }) : window.imc.invoke('calendar:schedule', { accountId, ...body })
    )
  }

  const cancelMeeting = async () => {
    if (!event) return
    const ok = await askConfirm({ title: 'Cancel this meeting?', message: 'Everyone invited is emailed a cancellation.', confirmLabel: 'Cancel meeting', cancelLabel: 'Keep it', danger: true })
    if (ok) void run(() => window.imc.invoke('calendar:cancel', { id: event.id }))
  }

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-labelledby="meet-title"
      className="m-auto w-xl max-w-[calc(100vw-2rem)] rounded-md border border-line-strong bg-raised p-0 text-ink"
    >
      <div className="max-h-[calc(100vh-4rem)] overflow-y-auto p-6">
        <h2 id="meet-title" className="mb-4 text-lg font-semibold">
          {event === null ? 'New meeting' : editable ? 'Your meeting' : event.summary || 'Meeting'}
        </h2>

        {!editable && event ? (
          <div className="space-y-3 text-ink-2">
            <p className="num">{whenText(event.start, event.end, event.allDay)}</p>
            {event.repeats && <p>{event.repeats}</p>}
            {event.location && <p className="break-words">{event.location}</p>}
            {event.organizer && <p>Organized by {event.organizer.name || event.organizer.email}</p>}
            {event.description && (
              <p className="max-h-40 overflow-y-auto text-sm break-words whitespace-pre-wrap text-ink-3">{event.description}</p>
            )}
            {safeWebUrl(event.onlineUrl) && (
              <p>
                <a href={safeWebUrl(event.onlineUrl) ?? undefined} target="_blank" rel="noreferrer noopener" className="text-accent underline underline-offset-2">
                  Join online
                </a>
              </p>
            )}
            <p className="text-sm text-ink-3">
              {event.readOnly
                ? `From the calendar of ${accounts.find((a) => a.id === event.accountId)?.email ?? 'your account'}. Change it there, and it updates here.`
                : "This is someone else's meeting. Change your answer from the invitation email."}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <label className="block text-sm text-ink-2">
              Title
              <input autoFocus value={summary} maxLength={200} onChange={(e) => setSummary(e.target.value)} className={field} />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-sm text-ink-2">
                Starts
                <input type={allDay ? 'date' : 'datetime-local'} value={allDay ? start.slice(0, 10) : start} onChange={(e) => moveStart(allDay ? `${e.target.value}T00:00` : e.target.value)} className={`${field} num`} />
              </label>
              <label className="block text-sm text-ink-2">
                Ends
                <input type={allDay ? 'date' : 'datetime-local'} value={allDay ? end.slice(0, 10) : end} onChange={(e) => setEnd(allDay ? `${e.target.value}T00:00` : e.target.value)} className={`${field} num`} />
              </label>
            </div>
            <label className="flex items-center gap-2 text-sm text-ink-2">
              <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
              All day
            </label>
            <div className="flex items-end gap-3">
              <label className="block flex-1 text-sm text-ink-2">
                Repeat
                <select
                  value={repeat}
                  onChange={(e) => {
                    setRepeat(e.target.value as typeof repeat)
                    setChangedRepeat(true)
                  }}
                  className={field}
                >
                  <option value="none">{event?.rrule && !changedRepeat ? `Keep: ${event.repeats ?? 'repeats'}` : 'Does not repeat'}</option>
                  <option value="daily">Every day</option>
                  <option value="weekly">Every week</option>
                  <option value="biweekly">Every 2 weeks</option>
                  <option value="monthly">Every month</option>
                </select>
              </label>
              {repeat !== 'none' && (
                <label className="block w-28 text-sm text-ink-2">
                  Times in all
                  <input type="number" min={2} max={200} value={repeatCount} onChange={(e) => setRepeatCount(Number(e.target.value) || 2)} className={`${field} num`} />
                </label>
              )}
            </div>
            {event === null && accounts.length > 1 && (
              <label className="block text-sm text-ink-2">
                Send from
                <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={field}>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.displayName ? `${a.displayName} <${a.email}>` : a.email}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="-mx-4 border-t border-line">
              <RecipientInput label="Invite" value={attendees} onChange={setAttendees} />
            </div>
            <label className="block text-sm text-ink-2">
              Where
              <input value={location} maxLength={500} onChange={(e) => setLocation(e.target.value)} className={field} />
            </label>
            <label className="block text-sm text-ink-2">
              Online meeting link (optional)
              <input
                type="url"
                value={onlineUrl}
                placeholder="https://"
                onChange={(e) => setOnlineUrl(e.target.value)}
                className={field}
              />
            </label>
            <label className="block text-sm text-ink-2">
              Notes
              <textarea
                value={description}
                rows={3}
                maxLength={5000}
                onChange={(e) => setDescription(e.target.value)}
                className="mt-1 block w-full rounded-md border border-line-strong bg-sheet px-2.5 py-1.5 text-ink"
              />
            </label>
            {event && (
              <p className="text-sm text-ink-3">
                Saving emails an updated invitation. If you move the time, everyone is asked to answer again.
              </p>
            )}
          </div>
        )}

        {error && (
          <p role="alert" className="mt-3 text-alert">
            {error}
          </p>
        )}
        {saved && <p className="mt-3 text-sm text-ink-3">Saved to {saved}</p>}

        <div className="mt-5 flex flex-wrap items-center gap-2">
          {event && (
            <>
              {!event.readOnly && (
              <button
                type="button"
                className={`${btn} flex items-center gap-1.5`}
                onClick={() =>
                  void window.imc
                    .invoke('calendar:exportIcs', { id: event.id })
                    .then((r) => setSaved(r.saved))
                    .catch((e) => setError(errText(e)))
                }
              >
                <Download size={14} strokeWidth={1.75} aria-hidden />
                .ics
              </button>
              )}
              {event.messageId && (
                <button
                  type="button"
                  className={`${btn} flex items-center gap-1.5`}
                  onClick={() => {
                    onOpenMessage(event.messageId!)
                    dialog.current?.close()
                  }}
                >
                  <Mail size={14} strokeWidth={1.75} aria-hidden />
                  Open invitation
                </button>
              )}
              {event.mine && (
                <button type="button" className={`${btn} text-alert`} disabled={busy} onClick={() => void cancelMeeting()}>
                  Cancel meeting
                </button>
              )}
            </>
          )}
          <span className="flex-1" />
          <button type="button" className={btn} onClick={() => dialog.current?.close()}>
            Close
          </button>
          {editable && (
            <button
              type="button"
              disabled={busy}
              onClick={save}
              className="h-9 rounded-md bg-accent px-4 font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
            >
              {event ? 'Save and send update' : 'Send invitation'}
            </button>
          )}
        </div>
      </div>
    </dialog>
  )
}
