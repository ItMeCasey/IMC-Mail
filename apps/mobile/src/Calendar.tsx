import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, useWindowDimensions, type ScrollViewInstance } from 'react-native'
import { dayKey, groupByDayOf, monthGrid, placeDay, weekOf } from '@imc/core'
import { appPrefs, meetingsBetween, type Occurrence } from '@imc/mail'
import { holidaysBetween } from '@imc/mail/holidays'
import { useChanged } from './changes'
import { AppBar, BackIcon, IconButton, MenuLabel, Sheet } from './chrome'
import { items } from './db'
import { syncNow } from './phonesync'
import { colors, Link, Note, radius } from './ui'

type Mode = 'day' | 'week' | 'month' | 'agenda'
const MODES: { id: Mode; label: string }[] = [
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'agenda', label: 'Agenda' }
]

const DAY = 86_400_000
const HOUR_H = 56
const GUTTER = 44
const AGENDA_DAYS = 14
const startOfDay = (d: Date | number): Date => {
  const x = new Date(d)
  return new Date(x.getFullYear(), x.getMonth(), x.getDate())
}
const addDays = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
const sameDay = (a: Date, b: Date): boolean => dayKey(a) === dayKey(b)

const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const hourLabel = new Intl.DateTimeFormat(undefined, { hour: 'numeric' })
const longDay = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
const shortDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const monthName = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
const weekdayNarrow = new Intl.DateTimeFormat(undefined, { weekday: 'narrow' })

/** The calendar tab: Day, Week, Month and Agenda views of the meetings synced from your other devices, with holidays. */
export default function Calendar() {
  const changed = useChanged()
  const [mode, setMode] = useState<Mode>('week')
  const [anchor, setAnchor] = useState(() => startOfDay(Date.now()))
  const [refreshing, setRefreshing] = useState(false)
  const [open, setOpen] = useState<Occurrence | null>(null)

  const today = startOfDay(Date.now())

  // The days each view needs data for.
  const span = useMemo((): { from: Date; to: Date } => {
    if (mode === 'day') return { from: anchor, to: addDays(anchor, 1) }
    if (mode === 'week') {
      const w = weekOf(anchor)
      return { from: w[0]!, to: addDays(w[6]!, 1) }
    }
    if (mode === 'month') {
      const weeks = monthGrid(anchor.getFullYear(), anchor.getMonth())
      return { from: weeks[0]![0]!, to: addDays(weeks[weeks.length - 1]![6]!, 1) }
    }
    return { from: anchor, to: addDays(anchor, AGENDA_DAYS) }
  }, [mode, anchor])

  const data = useMemo(() => {
    void changed
    const prefs = appPrefs(items)
    const all = meetingsBetween(items, span.from.getTime(), span.to.getTime())
    let holidays: { date: string; name: string }[] = []
    if (prefs.showHolidays) {
      try {
        holidays = holidaysBetween(prefs.holidayCountry, span.from.getTime(), span.to.getTime())
      } catch {
        holidays = []
      }
    }
    const holidayBy = new Map<string, string[]>()
    for (const h of holidays) holidayBy.set(h.date, [...(holidayBy.get(h.date) ?? []), h.name])
    return { all, byDay: groupByDayOf(all, (o) => o.allDay), holidayBy }
  }, [span, changed])

  // A color for each account, the same on every view.
  const tone = useMemo(() => {
    const accounts = [...new Set(items.list('meeting').map((m) => m.id.split('\u001f')[0] ?? ''))].sort()
    return (account: string) => colors.tape[Math.max(0, accounts.indexOf(account)) % colors.tape.length]!
  }, [changed])

  const step = (dir: 1 | -1) =>
    setAnchor((a) => {
      if (mode === 'day') return addDays(a, dir)
      if (mode === 'week') return addDays(a, 7 * dir)
      if (mode === 'month') return new Date(a.getFullYear(), a.getMonth() + dir, 1)
      return addDays(a, AGENDA_DAYS * dir)
    })

  const refresh = useCallback(async () => {
    setRefreshing(true)
    await syncNow()
    setRefreshing(false)
  }, [])
  useEffect(() => void refresh(), [refresh])

  const title =
    mode === 'day' ? longDay.format(anchor) : mode === 'week' ? `${shortDay.format(span.from)} – ${shortDay.format(addDays(span.to, -1))}` : mode === 'month' ? monthName.format(anchor) : `${shortDay.format(anchor)} – ${shortDay.format(addDays(anchor, AGENDA_DAYS - 1))}`

  const pickDay = (d: Date) => {
    setAnchor(startOfDay(d))
    setMode('day')
  }

  return (
    <View style={{ flex: 1 }}>
      <AppBar
        left={
          <IconButton label="Previous" onPress={() => step(-1)}>
            <BackIcon />
          </IconButton>
        }
        title={title}
        subtitle={sameDay(span.from, today) || (today >= span.from && today < span.to) ? 'Includes today' : undefined}
        right={
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Pressable accessibilityRole="button" onPress={() => setAnchor(today)} style={st.today}>
              <Text style={st.todayText}>Today</Text>
            </Pressable>
            <IconButton label="Next" onPress={() => step(1)}>
              <View style={{ transform: [{ rotate: '180deg' }] }}>
                <BackIcon />
              </View>
            </IconButton>
          </View>
        }
      />
      <View style={st.modes}>
        {MODES.map((m) => (
          <Pressable key={m.id} accessibilityRole="tab" accessibilityState={{ selected: mode === m.id }} onPress={() => setMode(m.id)} style={[st.mode, mode === m.id && st.modeOn]}>
            <Text style={[st.modeText, mode === m.id && st.modeTextOn]}>{m.label}</Text>
          </Pressable>
        ))}
      </View>

      {(mode === 'day' || mode === 'week') && (
        <TimeGrid
          days={mode === 'day' ? [anchor] : weekOf(anchor)}
          byDay={data.byDay}
          holidayBy={data.holidayBy}
          today={today}
          tone={tone}
          single={mode === 'day'}
          refreshing={refreshing}
          onRefresh={() => void refresh()}
          onPickDay={pickDay}
          onPick={setOpen}
        />
      )}
      {mode === 'month' && <MonthView anchor={anchor} byDay={data.byDay} holidayBy={data.holidayBy} today={today} tone={tone} refreshing={refreshing} onRefresh={() => void refresh()} onPickDay={pickDay} />}
      {mode === 'agenda' && <AgendaView days={Array.from({ length: AGENDA_DAYS }, (_, i) => addDays(anchor, i))} byDay={data.byDay} holidayBy={data.holidayBy} tone={tone} refreshing={refreshing} onRefresh={() => void refresh()} onPick={setOpen} />}

      <Sheet open={open !== null} onClose={() => setOpen(null)}>
        {open && (
          <View style={{ paddingHorizontal: 20, paddingBottom: 12, gap: 6 }}>
            <Text style={{ color: colors.text, fontSize: 18, fontWeight: '600' }}>{open.summary || 'Meeting'}</Text>
            <Text style={{ color: colors.muted }}>
              {longDay.format(open.start)}
              {open.allDay ? ' · all day' : ` · ${clock.format(open.start)} – ${clock.format(open.end)}`}
            </Text>
            {open.location !== '' && <Text style={{ color: colors.soft }}>{open.location}</Text>}
            <Text style={{ color: tone(open.account), fontSize: 12 }}>● {open.account}</Text>
            {open.onlineUrl && /^https?:/i.test(open.onlineUrl) && <Link onPress={() => void Linking.openURL(open.onlineUrl!)}>Join online</Link>}
          </View>
        )}
        <MenuLabel>Meetings come from your other devices</MenuLabel>
      </Sheet>
    </View>
  )
}

// ---- day and week -----------------------------------------------------------------------------------------------

interface GridProps {
  days: Date[]
  byDay: Map<string, Occurrence[]>
  holidayBy: Map<string, string[]>
  today: Date
  tone: (account: string) => string
  single: boolean
  refreshing: boolean
  onRefresh: () => void
  onPickDay: (d: Date) => void
  onPick: (o: Occurrence) => void
}

/** Days as columns of hours. Overlapping meetings sit side by side. */
function TimeGrid({ days, byDay, holidayBy, today, tone, single, refreshing, onRefresh, onPickDay, onPick }: GridProps) {
  const { width } = useWindowDimensions()
  const colW = (width - GUTTER) / days.length
  const scroll = useRef<ScrollViewInstance>(null)
  useEffect(() => {
    // Start near the morning, or where the working day begins.
    scroll.current?.scrollTo({ y: 7 * HOUR_H, animated: false })
  }, [])
  const now = Date.now()
  const nowY = ((now - today.getTime()) / 3_600_000) * HOUR_H
  const allDay = days.map((d) => (byDay.get(dayKey(d)) ?? []).filter((o) => o.allDay))

  return (
    <View style={{ flex: 1 }}>
      <View style={st.headRow}>
        <View style={{ width: GUTTER }} />
        {days.map((d) => {
          const isToday = sameDay(d, today)
          return (
            <Pressable key={dayKey(d)} accessibilityRole="button" onPress={() => !single && onPickDay(d)} style={[st.headCell, { width: colW }]}>
              <Text style={[st.headDay, isToday && { color: colors.accent }]}>{single ? weekday.format(d) : weekdayNarrow.format(d)}</Text>
              <Text style={[st.headDate, isToday && st.headDateToday]}>{d.getDate()}</Text>
            </Pressable>
          )
        })}
      </View>
      {(allDay.some((a) => a.length > 0) || days.some((d) => holidayBy.has(dayKey(d)))) && (
        <View style={st.allDayRow}>
          <View style={{ width: GUTTER, justifyContent: 'center' }}>
            <Text style={st.gutterText}>all day</Text>
          </View>
          {days.map((d, i) => (
            <View key={dayKey(d)} style={{ width: colW, paddingHorizontal: 1, gap: 2 }}>
              {(holidayBy.get(dayKey(d)) ?? []).map((h) => (
                <Text key={h} numberOfLines={1} style={st.holiday}>
                  {h}
                </Text>
              ))}
              {allDay[i]!.map((o) => (
                <Pressable key={o.id} accessibilityRole="button" onPress={() => onPick(o)} style={[st.chip, { backgroundColor: tone(o.account) + '33', borderLeftColor: tone(o.account) }]}>
                  <Text numberOfLines={1} style={st.chipText}>
                    {o.summary || 'Meeting'}
                  </Text>
                </Pressable>
              ))}
            </View>
          ))}
        </View>
      )}
      <ScrollView ref={scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.muted} colors={[colors.accent]} progressBackgroundColor={colors.raised} />} contentContainerStyle={{ paddingBottom: 24 }}>
        <View style={{ height: 24 * HOUR_H, flexDirection: 'row' }}>
          <View style={{ width: GUTTER }}>
            {Array.from({ length: 24 }, (_, h) => (
              <Text key={h} style={[st.gutterText, { position: 'absolute', top: h * HOUR_H - 7, right: 6 }]}>
                {h === 0 ? '' : hourLabel.format(new Date(2026, 0, 1, h))}
              </Text>
            ))}
          </View>
          <View style={{ flex: 1, flexDirection: 'row' }}>
            {Array.from({ length: 24 }, (_, h) => (
              <View key={h} pointerEvents="none" style={[st.hourLine, { top: h * HOUR_H }]} />
            ))}
            {days.map((d) => {
              const start = d.getTime()
              const placed = placeDay((byDay.get(dayKey(d)) ?? []).filter((o) => !o.allDay), start, start + DAY)
              const isToday = sameDay(d, today)
              return (
                <View key={dayKey(d)} style={[{ width: colW, height: 24 * HOUR_H }, st.dayCol, isToday && { backgroundColor: colors.selected + '55' }]}>
                  {placed.map((p) => {
                    const o = p.o
                    const top = (p.from / 60) * HOUR_H
                    const height = Math.max(((p.to - p.from) / 60) * HOUR_H, 22)
                    const w = colW / p.lanes
                    return (
                      <Pressable
                        key={o.id}
                        accessibilityRole="button"
                        onPress={() => onPick(o)}
                        style={[st.block, { top, height: height - 1, left: p.lane * w, width: w - 2, backgroundColor: tone(o.account) + '40', borderLeftColor: tone(o.account) }]}
                      >
                        <Text numberOfLines={single ? 2 : 3} style={st.blockTitle}>
                          {o.summary || 'Meeting'}
                        </Text>
                        {single && height > 40 && (
                          <Text numberOfLines={1} style={st.blockTime}>
                            {clock.format(o.start)} – {clock.format(o.end)}
                            {o.location ? ` · ${o.location}` : ''}
                          </Text>
                        )}
                      </Pressable>
                    )
                  })}
                  {isToday && nowY >= 0 && nowY <= 24 * HOUR_H && <View pointerEvents="none" style={[st.nowLine, { top: nowY }]} />}
                </View>
              )
            })}
          </View>
        </View>
      </ScrollView>
    </View>
  )
}

// ---- month ------------------------------------------------------------------------------------------------------

function MonthView({ anchor, byDay, holidayBy, today, tone, refreshing, onRefresh, onPickDay }: { anchor: Date; byDay: Map<string, Occurrence[]>; holidayBy: Map<string, string[]>; today: Date; tone: (a: string) => string; refreshing: boolean; onRefresh: () => void; onPickDay: (d: Date) => void }) {
  const weeks = monthGrid(anchor.getFullYear(), anchor.getMonth())
  return (
    <ScrollView refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.muted} colors={[colors.accent]} progressBackgroundColor={colors.raised} />} contentContainerStyle={{ flexGrow: 1 }}>
      <View style={st.monthHead}>
        {weeks[0]!.map((d) => (
          <Text key={d.getDay()} style={st.monthHeadText}>
            {weekday.format(d)}
          </Text>
        ))}
      </View>
      <View style={{ flex: 1 }}>
        {weeks.map((week, wi) => (
          <View key={wi} style={st.monthRow}>
            {week.map((d) => {
              const key = dayKey(d)
              const here = byDay.get(key) ?? []
              const holidays = holidayBy.get(key) ?? []
              const isToday = sameDay(d, today)
              const inMonth = d.getMonth() === anchor.getMonth()
              return (
                <Pressable key={key} accessibilityRole="button" accessibilityLabel={longDay.format(d)} onPress={() => onPickDay(d)} style={[st.cell, isToday && st.cellToday, holidays.length > 0 && { backgroundColor: colors.warn + '14' }]}>
                  <Text style={[st.cellDate, !inMonth && { color: colors.faint, opacity: 0.55 }, isToday && { color: colors.accent, fontWeight: '700' }]}>{d.getDate()}</Text>
                  {holidays.slice(0, 1).map((h) => (
                    <Text key={h} numberOfLines={1} style={st.cellHoliday}>
                      {h}
                    </Text>
                  ))}
                  {here.slice(0, holidays.length > 0 ? 2 : 3).map((o) => (
                    <View key={o.id} style={[st.cellChip, { backgroundColor: tone(o.account) + '40', borderLeftColor: tone(o.account) }]}>
                      <Text numberOfLines={1} style={st.cellChipText}>
                        {o.summary || 'Meeting'}
                      </Text>
                    </View>
                  ))}
                  {here.length > (holidays.length > 0 ? 2 : 3) && <Text style={st.more}>+{here.length - (holidays.length > 0 ? 2 : 3)}</Text>}
                </Pressable>
              )
            })}
          </View>
        ))}
      </View>
    </ScrollView>
  )
}

// ---- agenda -----------------------------------------------------------------------------------------------------

function AgendaView({ days, byDay, holidayBy, tone, refreshing, onRefresh, onPick }: { days: Date[]; byDay: Map<string, Occurrence[]>; holidayBy: Map<string, string[]>; tone: (a: string) => string; refreshing: boolean; onRefresh: () => void; onPick: (o: Occurrence) => void }) {
  const busy = days.filter((d) => (byDay.get(dayKey(d))?.length ?? 0) > 0 || holidayBy.has(dayKey(d)))
  return (
    <ScrollView refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.muted} colors={[colors.accent]} progressBackgroundColor={colors.raised} />} contentContainerStyle={{ padding: 16, gap: 14, flexGrow: 1 }}>
      {busy.length === 0 && <Note>Nothing in these {days.length} days. Meetings come from your other devices; pull down to sync.</Note>}
      {busy.map((d) => (
        <View key={dayKey(d)} style={{ gap: 6 }}>
          <Text style={{ color: colors.soft, fontWeight: '600' }}>{longDay.format(d)}</Text>
          {(holidayBy.get(dayKey(d)) ?? []).map((h) => (
            <Text key={h} style={{ color: colors.warn }}>
              {h}
            </Text>
          ))}
          {(byDay.get(dayKey(d)) ?? []).map((o) => (
            <Pressable key={o.id} accessibilityRole="button" onPress={() => onPick(o)} style={[st.agendaCard, { borderLeftColor: tone(o.account) }]}>
              <Text style={{ color: colors.text, fontSize: 16 }}>{o.summary || 'Meeting'}</Text>
              <Text style={{ color: colors.muted, fontSize: 13 }}>
                {o.allDay ? 'All day' : `${clock.format(o.start)} – ${clock.format(o.end)}`}
                {o.location ? ` · ${o.location}` : ''}
              </Text>
            </Pressable>
          ))}
        </View>
      ))}
    </ScrollView>
  )
}

const st = StyleSheet.create({
  today: { borderWidth: 1, borderColor: colors.lineStrong, borderRadius: radius, paddingHorizontal: 10, paddingVertical: 6, marginRight: 2 },
  todayText: { color: colors.soft, fontSize: 13, fontWeight: '500' },
  modes: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  mode: { flex: 1, alignItems: 'center', paddingVertical: 11, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  modeOn: { borderBottomColor: colors.accent },
  modeText: { color: colors.muted, fontSize: 14, fontWeight: '500' },
  modeTextOn: { color: colors.text, fontWeight: '600' },
  headRow: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  headCell: { alignItems: 'center', paddingVertical: 6 },
  headDay: { color: colors.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 },
  headDate: { color: colors.text, fontSize: 17, fontWeight: '600', minWidth: 28, textAlign: 'center', paddingVertical: 2, borderRadius: 14, overflow: 'hidden' },
  headDateToday: { color: colors.onAccent, backgroundColor: colors.accent },
  allDayRow: { flexDirection: 'row', paddingVertical: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  gutterText: { color: colors.faint, fontSize: 10 },
  holiday: { color: colors.warn, fontSize: 11 },
  chip: { borderLeftWidth: 3, paddingHorizontal: 4, paddingVertical: 2, borderRadius: 2 },
  chipText: { color: colors.text, fontSize: 11 },
  hourLine: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  dayCol: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.line },
  block: { position: 'absolute', borderLeftWidth: 3, borderRadius: 3, paddingHorizontal: 4, paddingVertical: 2, overflow: 'hidden' },
  blockTitle: { color: colors.text, fontSize: 12, fontWeight: '600' },
  blockTime: { color: colors.soft, fontSize: 11 },
  nowLine: { position: 'absolute', left: 0, right: 0, height: 2, backgroundColor: colors.danger },
  monthHead: { flexDirection: 'row', paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  monthHeadText: { flex: 1, textAlign: 'center', color: colors.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 },
  monthRow: { flex: 1, minHeight: 92, flexDirection: 'row' },
  cell: { flex: 1, padding: 3, gap: 2, borderRightWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  cellToday: { borderWidth: 2, borderColor: colors.accent },
  cellDate: { color: colors.soft, fontSize: 12, fontVariant: ['tabular-nums'] },
  cellHoliday: { color: colors.warn, fontSize: 9 },
  cellChip: { borderLeftWidth: 2, paddingHorizontal: 2, borderRadius: 2 },
  cellChipText: { color: colors.text, fontSize: 9 },
  more: { color: colors.muted, fontSize: 9 },
  agendaCard: { backgroundColor: colors.raised, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, borderLeftWidth: 3, borderRadius: radius, padding: 12, gap: 2 }
})
