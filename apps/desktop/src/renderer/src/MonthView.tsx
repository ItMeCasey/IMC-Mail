import type { CalendarEvent, CalendarOccurrence } from '@imc/core'
import { dayKey, groupByDay, monthGrid } from './monthGrid'
import { Private } from './streamsafe'

const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
const SHOWN = 3

/** A month of meetings, a week to a row. Click a meeting to open it, or an empty day to schedule one. */
export default function MonthView({
  year,
  month,
  occurrences,
  holidays,
  hide,
  onOpen,
  onNew
}: {
  year: number
  month: number
  occurrences: CalendarOccurrence[]
  /** Public holidays to mark on their days. */
  holidays: { date: string; name: string }[]
  hide: boolean
  onOpen: (e: CalendarEvent) => void
  /** A day was clicked: its date at 9:00 local, as epoch ms. */
  onNew: (startAt: number) => void
}) {
  const weeks = monthGrid(year, month)
  const byDay = groupByDay(occurrences)
  const today = dayKey(new Date())
  const holidaysByDay = new Map<string, string[]>()
  for (const h of holidays) holidaysByDay.set(h.date, [...(holidaysByDay.get(h.date) ?? []), h.name])
  const heads = weeks[0]!.map((d) => weekday.format(d))

  return (
    <div role="grid" aria-label="Month" className="flex min-h-0 flex-1 flex-col">
      <div role="row" className="grid shrink-0 grid-cols-7 border-b border-line">
        {heads.map((h) => (
          <div key={h} role="columnheader" className="px-2 py-1.5 text-sm font-medium text-ink-2">
            {h}
          </div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 auto-rows-fr overflow-y-auto" style={{ gridTemplateRows: `repeat(${weeks.length}, minmax(6.5rem, 1fr))` }}>
        {weeks.map((week) => (
          <div key={dayKey(week[0]!)} role="row" className="grid grid-cols-7">
            {week.map((d) => {
              const key = dayKey(d)
              const items = [...(byDay.get(key) ?? [])].sort((a, b) => a.start - b.start)
              const inMonth = d.getMonth() === month
              return (
                <div
                  key={key}
                  role="gridcell"
                  aria-label={d.toDateString()}
                  onClick={() => onNew(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9).getTime())}
                  aria-current={key === today ? 'date' : undefined}
                  className={`min-w-0 cursor-default space-y-0.5 border-r border-b border-line p-1 ${inMonth ? '' : 'bg-rail text-ink-3'} ${key === today ? 'relative z-10 ring-2 ring-accent ring-inset' : ''}`}
                >
                  <div className="flex">
                    <span className={`num grid h-6 min-w-6 place-items-center px-1 text-sm ${key === today ? 'font-semibold text-ink' : ''}`}>
                      {d.getDate()}
                    </span>
                  </div>
                  {(holidaysByDay.get(key) ?? []).map((name) => (
                    <span key={name} title={name} className="block truncate rounded-sm bg-selected px-1.5 text-xs leading-5 text-ink-2">
                      {name}
                    </span>
                  ))}
                  {items.slice(0, SHOWN).map((o) => (
                    <button
                      key={`${o.event.id}:${o.start}`}
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        onOpen(o.event)
                      }}
                      title={hide ? undefined : o.event.summary}
                      className="block w-full truncate rounded-sm border border-line-strong px-1.5 py-0.5 text-left text-xs text-ink hover:bg-hover"
                    >
                      {!o.event.allDay && <span className="num mr-1 text-ink-3">{clock.format(o.start)}</span>}
                      <Private active={hide}>{o.event.summary || '(no title)'}</Private>
                    </button>
                  ))}
                  {items.length > SHOWN && <span className="block px-1.5 text-xs text-ink-3">+{items.length - SHOWN} more</span>}
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
