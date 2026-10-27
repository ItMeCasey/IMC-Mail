import { useCallback, useEffect, useMemo, useState } from 'react'
import { Linking, Text, View } from 'react-native'
import { appPrefs, meetingsBetween } from '@imc/mail'
import { holidaysBetween } from '@imc/mail/holidays'
import { useChanged } from './changes'
import { items } from './db'
import { syncNow } from './phonesync'
import { Body, Card, colors, Link, Note, Title } from './ui'

const DAY = 86_400_000
const PAGE_DAYS = 14
const dayHead = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const startOfDay = (ms: number): number => new Date(new Date(ms).getFullYear(), new Date(ms).getMonth(), new Date(ms).getDate()).getTime()
const dayKey = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The calendar tab: meetings from your other devices, and public holidays if you turned them on, day by day. */
export default function Agenda() {
  const changed = useChanged()
  const [page, setPage] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const from = startOfDay(Date.now()) + page * PAGE_DAYS * DAY
  const to = from + PAGE_DAYS * DAY

  const days = useMemo(() => {
    void changed
    const prefs = appPrefs(items)
    const meetings = meetingsBetween(items, from, to)
    let holidays: { date: string; name: string }[] = []
    if (prefs.showHolidays) {
      try {
        holidays = holidaysBetween(prefs.holidayCountry, from, to)
      } catch {
        holidays = []
      }
    }
    const byDay = new Map<string, { at: number; meetings: typeof meetings; holidays: string[] }>()
    const slot = (at: number) => {
      const k = dayKey(at)
      if (!byDay.has(k)) byDay.set(k, { at: startOfDay(at), meetings: [], holidays: [] })
      return byDay.get(k)!
    }
    for (const m of meetings) slot(m.start).meetings.push(m)
    for (const h of holidays) {
      const [y, mo, d] = h.date.split('-').map(Number)
      slot(new Date(y!, mo! - 1, d!).getTime()).holidays.push(h.name)
    }
    return [...byDay.values()].sort((a, b) => a.at - b.at)
  }, [changed, from, to])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    await syncNow()
    setRefreshing(false)
  }, [])

  useEffect(() => void refresh(), [refresh])

  return (
    <Body refreshing={refreshing} onRefresh={() => void refresh()}>
      <Title>Calendar</Title>
      <View style={{ flexDirection: 'row', gap: 20 }}>
        {page > 0 && <Link onPress={() => setPage(page - 1)}>‹ Earlier</Link>}
        {page > 0 && <Link onPress={() => setPage(0)}>Today</Link>}
        <Link onPress={() => setPage(page + 1)}>Later ›</Link>
      </View>
      {days.length === 0 && <Note>Nothing in these {PAGE_DAYS} days. Meetings come from your other devices; pull down to sync.</Note>}
      {days.map((d) => (
        <View key={d.at} style={{ gap: 6 }}>
          <Text style={{ color: colors.soft, fontWeight: '600' }}>{dayHead.format(d.at)}</Text>
          {d.holidays.map((h) => (
            <Text key={h} style={{ color: colors.warn }}>
              {h}
            </Text>
          ))}
          {d.meetings.map((m) => (
            <Card key={m.id}>
              <Text style={{ color: colors.text, fontSize: 16 }}>{m.summary || 'Meeting'}</Text>
              <Text style={{ color: colors.muted, fontSize: 13 }}>
                {m.allDay ? 'All day' : `${clock.format(m.start)} – ${clock.format(m.end)}`}
                {m.location ? ` · ${m.location}` : ''}
              </Text>
              {m.onlineUrl && /^https?:/i.test(m.onlineUrl) && <Link onPress={() => void Linking.openURL(m.onlineUrl!)}>Join online</Link>}
            </Card>
          ))}
        </View>
      ))}
    </Body>
  )
}
