import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarDays, MapPin, Plus, Repeat, Video } from 'lucide-react'
import type { Account, CalendarEvent, CalendarOccurrence } from '@imc/core'
import MeetingDialog from './MeetingDialog'
import { RESPONSE_LABEL } from './InviteCard'
import { Private } from './streamsafe'

const dayHead = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const DAYS = 30

const startOfDay = (ms: number) => new Date(new Date(ms).setHours(0, 0, 0, 0)).getTime()

const label = (e: CalendarEvent): string =>
  e.mine ? 'Organizer' : e.myResponse ? RESPONSE_LABEL[e.myResponse] : 'No answer'

/** The next 30 days of meetings, from invitations you accepted and meetings you organize. */
export default function Agenda({
  accounts,
  hide,
  onOpenMessage
}: {
  accounts: Account[]
  hide: boolean
  onOpenMessage: (id: string) => void
}) {
  const qc = useQueryClient()
  const from = useMemo(() => startOfDay(Date.now()), [])
  const to = from + DAYS * 86_400_000
  const list = useQuery({
    queryKey: ['calendar', from],
    queryFn: () => window.imc.invoke('calendar:list', { from, to })
  })
  const [editing, setEditing] = useState<CalendarEvent | 'new' | null>(null)

  const days = useMemo(() => {
    const by = new Map<number, CalendarOccurrence[]>()
    for (const o of [...(list.data ?? [])].sort((a, b) => a.start - b.start)) {
      const k = startOfDay(o.start)
      by.set(k, [...(by.get(k) ?? []), o])
    }
    return [...by]
  }, [list.data])

  return (
    <section aria-label="Calendar" className="flex min-w-0 flex-1 flex-col bg-sheet">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
        <CalendarDays size={18} strokeWidth={1.75} className="text-ink-2" aria-hidden />
        <h2 className="flex-1 text-md font-semibold">Calendar</h2>
        <button
          type="button"
          disabled={accounts.length === 0}
          onClick={() => setEditing('new')}
          className="flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 font-medium text-on-accent transition-colors duration-(--dur-fast) hover:bg-accent-hover disabled:opacity-50"
        >
          <Plus size={14} strokeWidth={1.75} aria-hidden />
          New meeting
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.isPending && <p className="p-4 text-ink-3">Loading…</p>}
        {list.data && days.length === 0 && (
          <div className="p-6 text-ink-2">
            <p className="font-medium text-ink">Nothing in the next {DAYS} days.</p>
            <p className="mt-1 max-w-prose text-sm">
              Meeting invitations you accept show up here, and so do meetings you schedule. Invitations
              from Outlook, Teams, Google Calendar and Zoom all work.
            </p>
          </div>
        )}
        {days.map(([day, items]) => (
          <div key={day}>
            <h3 className="sticky top-0 border-b border-line bg-sheet px-4 py-1.5 text-sm font-medium text-ink-2">
              {day === from ? 'Today · ' : ''}
              {dayHead.format(day)}
            </h3>
            <ul>
              {items.map((o) => (
                <li key={`${o.event.id}:${o.start}`} className="border-b border-line">
                  <button
                    type="button"
                    onClick={() => setEditing(o.event)}
                    className="flex w-full items-start gap-4 px-4 py-2.5 text-left transition-colors duration-(--dur-fast) hover:bg-hover"
                  >
                    <span className="num w-24 shrink-0 pt-px text-ink-2">
                      {o.event.allDay ? 'All day' : clock.format(o.start)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">
                        <Private active={hide}>{o.event.summary || '(no title)'}</Private>
                      </span>
                      <span className="flex items-center gap-3 text-sm text-ink-3">
                        {!o.event.allDay && <span className="num">until {clock.format(o.end)}</span>}
                        {o.event.location && (
                          <span className="flex min-w-0 items-center gap-1">
                            <MapPin size={12} strokeWidth={1.75} aria-hidden />
                            <span className="truncate">
                              <Private active={hide}>{o.event.location}</Private>
                            </span>
                          </span>
                        )}
                        {o.event.onlineUrl && <Video size={12} strokeWidth={1.75} aria-label="Online meeting" />}
                        {o.event.repeats && <Repeat size={12} strokeWidth={1.75} aria-label={o.event.repeats} />}
                      </span>
                    </span>
                    <span className="shrink-0 rounded-sm border border-line-strong px-1.5 text-xs leading-4 text-ink-2">
                      {label(o.event)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {editing && (
        <MeetingDialog
          accounts={accounts}
          event={editing === 'new' ? null : editing}
          onOpenMessage={onOpenMessage}
          onClose={() => setEditing(null)}
          onChanged={() => void qc.invalidateQueries({ queryKey: ['calendar'] })}
        />
      )}
    </section>
  )
}
