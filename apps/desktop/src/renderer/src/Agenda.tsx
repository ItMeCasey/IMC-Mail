import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarDays, ChevronLeft, ChevronRight, MapPin, Plus, Repeat, Video } from 'lucide-react'
import type { Account, CalendarEvent, CalendarOccurrence } from '@imc/core'
import MeetingDialog from './MeetingDialog'
import MonthView from './MonthView'
import { monthGrid } from './monthGrid'
import { RESPONSE_LABEL } from './InviteCard'
import { Private } from './streamsafe'

const dayHead = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const DAYS = 30
const monthName = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })

const startOfDay = (ms: number) => new Date(new Date(ms).setHours(0, 0, 0, 0)).getTime()

const label = (e: CalendarEvent): string =>
  e.mine ? 'Organizer' : e.myResponse ? RESPONSE_LABEL[e.myResponse] : e.readOnly ? 'On your calendar' : 'No answer'

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
  const [mode, setMode] = useState<'agenda' | 'month'>('agenda')
  const [cursor, setCursor] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1))
  const [newStart, setNewStart] = useState<number | null>(null)
  // The agenda shows the next 30 days; the month view shows the weeks drawn for that month.
  const [from, to] = useMemo(() => {
    if (mode === 'agenda') {
      const f = startOfDay(Date.now())
      return [f, f + DAYS * 86_400_000]
    }
    const weeks = monthGrid(cursor.getFullYear(), cursor.getMonth())
    const last = weeks[weeks.length - 1]![6]!
    return [weeks[0]![0]!.getTime(), new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1).getTime()]
  }, [mode, cursor])
  const list = useQuery({
    queryKey: ['calendar', from, to],
    queryFn: () => window.imc.invoke('calendar:list', { from, to })
  })
  const holidays = useQuery({
    queryKey: ['calendar', 'holidays', from, to],
    queryFn: () => window.imc.invoke('calendar:holidays', { from, to })
  })
  const [editing, setEditing] = useState<CalendarEvent | 'new' | null>(null)
  const step = (n: number) => setCursor((c) => new Date(c.getFullYear(), c.getMonth() + n, 1))

  const days = useMemo(() => {
    const by = new Map<number, { holidays: string[]; items: CalendarOccurrence[] }>()
    const at = (k: number) => by.get(k) ?? by.set(k, { holidays: [], items: [] }).get(k)!
    for (const h of holidays.data ?? []) at(new Date(`${h.date}T00:00:00`).getTime()).holidays.push(h.name)
    for (const o of [...(list.data ?? [])].sort((a, b) => a.start - b.start)) at(startOfDay(o.start)).items.push(o)
    return [...by].sort((a, b) => a[0] - b[0])
  }, [list.data, holidays.data])

  return (
    <section aria-label="Calendar" className="flex min-w-0 flex-1 flex-col bg-sheet">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
        <CalendarDays size={18} strokeWidth={1.75} className="text-ink-2" aria-hidden />
        <h2 className="text-md font-semibold">Calendar</h2>
        <div role="radiogroup" aria-label="View" className="flex divide-x divide-line overflow-hidden rounded-md border border-line-strong">
          {(['agenda', 'month'] as const).map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
              className={`h-8 px-3 text-sm ${mode === m ? 'bg-selected font-medium text-ink' : 'text-ink-2 hover:bg-hover hover:text-ink'}`}
            >
              {m === 'agenda' ? 'Agenda' : 'Month'}
            </button>
          ))}
        </div>
        {mode === 'month' && (
          <div className="flex items-center gap-1">
            <button className="grid size-8 place-items-center rounded-md text-ink-2 hover:bg-hover" aria-label="Previous month" onClick={() => step(-1)}>
              <ChevronLeft size={16} strokeWidth={1.75} aria-hidden />
            </button>
            <span className="num min-w-36 text-center font-medium">{monthName.format(cursor)}</span>
            <button className="grid size-8 place-items-center rounded-md text-ink-2 hover:bg-hover" aria-label="Next month" onClick={() => step(1)}>
              <ChevronRight size={16} strokeWidth={1.75} aria-hidden />
            </button>
            <button
              className="h-8 rounded-md border border-line-strong px-3 text-sm hover:bg-hover"
              onClick={() => setCursor(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}
            >
              Today
            </button>
          </div>
        )}
        <span className="flex-1" />
        <button
          type="button"
          disabled={accounts.length === 0}
          onClick={() => {
            setNewStart(null)
            setEditing('new')
          }}
          className="flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 font-medium text-on-accent transition-colors duration-(--dur-fast) hover:bg-accent-hover disabled:opacity-50"
        >
          <Plus size={14} strokeWidth={1.75} aria-hidden />
          New meeting
        </button>
      </header>

      {mode === 'month' && (
        <MonthView
          year={cursor.getFullYear()}
          month={cursor.getMonth()}
          occurrences={list.data ?? []}
          holidays={holidays.data ?? []}
          hide={hide}
          onOpen={(e) => setEditing(e)}
          onNew={(at) => {
            if (accounts.length === 0) return
            setNewStart(at)
            setEditing('new')
          }}
        />
      )}
      <div className={`min-h-0 flex-1 overflow-y-auto ${mode === 'month' ? 'hidden' : ''}`}>
        {list.isPending && <p className="p-4 text-ink-3">Loading…</p>}
        {list.data && holidays.data && days.length === 0 && (
          <div className="p-6 text-ink-2">
            <p className="font-medium text-ink">Nothing in the next {DAYS} days.</p>
            <p className="mt-1 max-w-prose text-sm">
              Meeting invitations you accept show up here, and so do meetings you schedule. Invitations
              from Outlook, Teams, Google Calendar and Zoom all work.
            </p>
          </div>
        )}
        {days.map(([day, { holidays: names, items }]) => (
          <div key={day}>
            <h3 className="sticky top-0 flex items-baseline gap-3 border-b border-line bg-sheet px-4 py-1.5 text-sm font-medium text-ink-2">
              <span>
                {day === from ? 'Today · ' : ''}
                {dayHead.format(day)}
              </span>
              {names.length > 0 && <span className="rounded-sm bg-selected px-1.5 text-xs font-normal">{names.join(' · ')}</span>}
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
          initialStart={editing === 'new' ? newStart : null}
          onOpenMessage={onOpenMessage}
          onClose={() => setEditing(null)}
          onChanged={() => void qc.invalidateQueries({ queryKey: ['calendar'] })}
        />
      )}
    </section>
  )
}
