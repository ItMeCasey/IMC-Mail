import { useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarDays, ChevronLeft, ChevronRight, MapPin, Plus, Repeat, Video } from 'lucide-react'
import type { Account, CalendarEvent, CalendarOccurrence } from '@imc/core'
import MeetingDialog from './MeetingDialog'
import MonthView from './MonthView'
import TimeGrid from './TimeGrid'
import { monthGrid } from './monthGrid'
import { RESPONSE_LABEL } from './InviteCard'
import { Private } from './streamsafe'

const dayHead = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const DAYS = 30
const monthName = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })
const rangeName = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

type Mode = 'agenda' | 'day' | 'week' | 'month'
const MODES: { id: Mode; label: string }[] = [
  { id: 'agenda', label: 'Agenda' },
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' }
]

const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
/** The Sunday that starts the week holding this day (the month view starts its weeks on Sunday too). */
const weekStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay())

/** Whether something between the pointer and `stop` can still scroll that way, so the wheel should scroll it first. */
function canScroll(from: EventTarget, stop: HTMLElement, dy: number): boolean {
  for (let el = from as HTMLElement | null; el && el !== stop; el = el.parentElement) {
    if (el.scrollHeight <= el.clientHeight + 1) continue
    const overflow = getComputedStyle(el).overflowY
    if (overflow !== 'auto' && overflow !== 'scroll') continue
    if (dy > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0) return true
  }
  return false
}

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
  const [mode, setMode] = useState<Mode>('agenda')
  const [cursor, setCursor] = useState(() => midnight(new Date()))
  const [newStart, setNewStart] = useState<number | null>(null)
  // The agenda shows the next 30 days; the others show their day, week, or the weeks drawn for the month.
  const shownDays = useMemo(() => {
    if (mode === 'day') return [cursor]
    if (mode === 'week') {
      const s = weekStart(cursor)
      return Array.from({ length: 7 }, (_, i) => new Date(s.getFullYear(), s.getMonth(), s.getDate() + i))
    }
    return []
  }, [mode, cursor])
  const [from, to] = useMemo(() => {
    if (mode === 'agenda') {
      const f = startOfDay(Date.now())
      return [f, f + DAYS * 86_400_000]
    }
    if (mode === 'day' || mode === 'week') {
      const last = shownDays[shownDays.length - 1]!
      return [shownDays[0]!.getTime(), new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1).getTime()]
    }
    const weeks = monthGrid(cursor.getFullYear(), cursor.getMonth())
    const last = weeks[weeks.length - 1]![6]!
    return [weeks[0]![0]!.getTime(), new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1).getTime()]
  }, [mode, cursor, shownDays])
  const list = useQuery({
    queryKey: ['calendar', from, to],
    queryFn: () => window.imc.invoke('calendar:list', { from, to })
  })
  const holidays = useQuery({
    queryKey: ['calendar', 'holidays', from, to],
    queryFn: () => window.imc.invoke('calendar:holidays', { from, to })
  })
  const [editing, setEditing] = useState<CalendarEvent | 'new' | null>(null)
  const step = (n: number) =>
    setCursor((c) =>
      mode === 'month'
        ? new Date(c.getFullYear(), c.getMonth() + n, 1)
        : new Date(c.getFullYear(), c.getMonth(), c.getDate() + n * (mode === 'week' ? 7 : 1))
    )
  const unit = mode === 'month' ? 'month' : mode === 'week' ? 'week' : 'day'
  const title =
    mode === 'month'
      ? monthName.format(cursor)
      : mode === 'day'
        ? dayHead.format(cursor)
        : mode === 'week'
          ? rangeName.formatRange(shownDays[0]!, shownDays[6]!)
          : ''

  // Scrolling moves the calendar: a month at a time in the month view; sideways (or with Shift) a week or a day at a
  // time in the others, where the wheel itself scrolls the hours.
  const wheel = useRef({ sum: 0, last: 0, lockedUntil: 0 })
  const onWheel = (e: React.WheelEvent<HTMLElement>) => {
    if (mode === 'agenda') return
    const sideways = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)
    if (!sideways && (mode !== 'month' || canScroll(e.target, e.currentTarget, e.deltaY))) return
    const delta = sideways ? e.deltaX || e.deltaY : e.deltaY
    const w = wheel.current
    const now = Date.now()
    if (now < w.lockedUntil) return
    w.sum = now - w.last > 250 ? delta : w.sum + delta
    w.last = now
    if (Math.abs(w.sum) < 40) return
    step(w.sum > 0 ? 1 : -1)
    w.sum = 0
    w.lockedUntil = now + 350
  }
  const newAt = (at: number) => {
    if (accounts.length === 0) return
    setNewStart(at)
    setEditing('new')
  }

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
          {MODES.map((m) => (
            <button
              key={m.id}
              role="radio"
              aria-checked={mode === m.id}
              onClick={() => setMode(m.id)}
              className={`h-8 px-3 text-sm ${mode === m.id ? 'bg-selected font-medium text-ink' : 'text-ink-2 hover:bg-hover hover:text-ink'}`}
            >
              {m.label}
            </button>
          ))}
        </div>
        {mode !== 'agenda' && (
          <div className="flex items-center gap-1">
            <button className="grid size-8 place-items-center rounded-md text-ink-2 hover:bg-hover" aria-label={`Previous ${unit}`} onClick={() => step(-1)}>
              <ChevronLeft size={16} strokeWidth={1.75} aria-hidden />
            </button>
            <span className="num min-w-48 text-center font-medium">{title}</span>
            <button className="grid size-8 place-items-center rounded-md text-ink-2 hover:bg-hover" aria-label={`Next ${unit}`} onClick={() => step(1)}>
              <ChevronRight size={16} strokeWidth={1.75} aria-hidden />
            </button>
            <button className="h-8 rounded-md border border-line-strong px-3 text-sm hover:bg-hover" onClick={() => setCursor(midnight(new Date()))}>
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
        <div className="flex min-h-0 flex-1 flex-col" onWheel={onWheel}>
          <MonthView
            year={cursor.getFullYear()}
            month={cursor.getMonth()}
            occurrences={list.data ?? []}
            holidays={holidays.data ?? []}
            hide={hide}
            onOpen={(e) => setEditing(e)}
            onNew={newAt}
          />
        </div>
      )}
      {(mode === 'day' || mode === 'week') && (
        <div className="flex min-h-0 flex-1 flex-col" onWheel={onWheel}>
          <TimeGrid days={shownDays} occurrences={list.data ?? []} holidays={holidays.data ?? []} hide={hide} onOpen={(e) => setEditing(e)} onNew={newAt} />
        </div>
      )}
      <div className={`min-h-0 flex-1 overflow-y-auto ${mode === 'agenda' ? '' : 'hidden'}`}>
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
