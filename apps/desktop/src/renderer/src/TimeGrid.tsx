import { useEffect, useRef, useState } from 'react'
import type { CalendarEvent, CalendarOccurrence } from '@imc/core'
import { dayKey, groupByDay } from './monthGrid'
import { placeDay } from './dayLayout'
import { Private } from './streamsafe'

/** Height of one hour, in pixels. */
const HOUR = 48
const MIN_BLOCK = 20
const hourLabel = new Intl.DateTimeFormat(undefined, { hour: 'numeric' })
const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' })

/** One day or a week, as columns of hours. Click an empty spot to schedule there, or a meeting to open it. */
export default function TimeGrid({
  days,
  occurrences,
  holidays,
  hide,
  onOpen,
  onNew
}: {
  days: Date[]
  occurrences: CalendarOccurrence[]
  holidays: { date: string; name: string }[]
  hide: boolean
  onOpen: (e: CalendarEvent) => void
  /** An empty spot was clicked: that time, rounded down to the half hour, as epoch ms. */
  onNew: (startAt: number) => void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])
  const today = dayKey(now)
  const first = days[0]!.getTime()
  const hasToday = days.some((d) => dayKey(d) === today)
  // Start the view a little before now (or the morning), so the day is already in sight.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = Math.max(0, (hasToday ? new Date().getHours() - 1 : 7) * HOUR)
  }, [first, days.length, hasToday])

  const byDay = groupByDay(occurrences)
  const cols = `3.5rem repeat(${days.length}, minmax(0, 1fr))`
  const hours = Array.from({ length: 24 }, (_, h) => h)

  return (
    <div role="grid" aria-label={days.length === 1 ? 'Day' : 'Week'} className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-line">
        <div className="grid" style={{ gridTemplateColumns: cols }}>
          <span />
          {days.map((d) => {
            const key = dayKey(d)
            return (
              <div key={key} role="columnheader" aria-current={key === today ? 'date' : undefined} className={`px-2 py-1.5 ${key === today ? 'ring-2 ring-accent ring-inset' : ''}`}>
                <span className="text-sm font-medium text-ink-2">{weekday.format(d)} </span>
                <span className={`num text-sm ${key === today ? 'font-semibold text-ink' : 'text-ink-2'}`}>{d.getDate()}</span>
              </div>
            )
          })}
        </div>
        <div className="grid" style={{ gridTemplateColumns: cols }}>
          <span className="px-1 pt-1 text-right text-xs text-ink-3">all day</span>
          {days.map((d) => {
            const key = dayKey(d)
            const names = holidays.filter((h) => h.date === key).map((h) => h.name)
            const allDay = (byDay.get(key) ?? []).filter((o) => o.event.allDay)
            return (
              <div key={key} className="min-w-0 space-y-0.5 border-l border-line p-1">
                {names.map((n) => (
                  <span key={n} title={n} className="block truncate rounded-sm bg-selected px-1.5 text-xs leading-5 text-ink-2">
                    {n}
                  </span>
                ))}
                {allDay.map((o) => (
                  <button
                    key={`${o.event.id}:${o.start}`}
                    type="button"
                    onClick={() => onOpen(o.event)}
                    className="block w-full truncate rounded-sm border border-line-strong px-1.5 text-left text-xs leading-5 text-ink hover:bg-hover"
                  >
                    <Private active={hide}>{o.event.summary || '(no title)'}</Private>
                  </button>
                ))}
              </div>
            )
          })}
        </div>
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <div className="relative grid" style={{ gridTemplateColumns: cols, height: HOUR * 24 }}>
          <div className="relative">
            {hours.slice(1).map((h) => (
              <span key={h} className="num absolute right-2 -translate-y-1/2 text-xs text-ink-3" style={{ top: h * HOUR }}>
                {hourLabel.format(new Date(2000, 0, 1, h))}
              </span>
            ))}
          </div>
          {days.map((d) => {
            const key = dayKey(d)
            const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
            const dayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
            const timed = (byDay.get(key) ?? []).filter((o) => !o.event.allDay)
            return (
              <div
                key={key}
                role="gridcell"
                aria-label={d.toDateString()}
                onClick={(e) => {
                  const y = e.clientY - e.currentTarget.getBoundingClientRect().top
                  const minutes = Math.min(23.5 * 60, Math.max(0, Math.floor((y / HOUR) * 2) * 30))
                  onNew(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, minutes).getTime())
                }}
                className={`relative cursor-default border-l border-line ${key === today ? 'ring-2 ring-accent ring-inset' : ''}`}
                style={{ backgroundImage: 'linear-gradient(to bottom, transparent calc(100% - 1px), var(--line) 0)', backgroundSize: `100% ${HOUR}px` }}
              >
                {placeDay(timed, dayStart, dayEnd, (MIN_BLOCK / HOUR) * 60).map((p) => (
                  <button
                    key={`${p.o.event.id}:${p.o.start}`}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      onOpen(p.o.event)
                    }}
                    title={hide ? undefined : p.o.event.summary}
                    className="absolute overflow-hidden rounded-sm border border-line-strong bg-raised px-1.5 py-0.5 text-left text-xs text-ink hover:bg-hover"
                    style={{
                      top: (p.from / 60) * HOUR,
                      height: Math.max(((p.to - p.from) / 60) * HOUR - 1, MIN_BLOCK),
                      left: `${(p.lane / p.lanes) * 100}%`,
                      width: `calc(${100 / p.lanes}% - 2px)`
                    }}
                  >
                    <span className="block truncate font-medium">
                      <Private active={hide}>{p.o.event.summary || '(no title)'}</Private>
                    </span>
                    <span className="num block truncate text-ink-3">{clock.format(p.o.start)}</span>
                  </button>
                ))}
                {key === today && (
                  <span aria-hidden className="pointer-events-none absolute right-0 left-0 z-10 h-0.5 bg-accent" style={{ top: ((now - dayStart) / 60_000 / 60) * HOUR }} />
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
