import { useCallback, useEffect, useMemo, useState } from 'react'
import { Text, View } from 'react-native'
import { DEAL_STAGES, listDeals, outstanding, setDealStage, type Deal } from '@imc/mail'
import { notifyChanged, useChanged } from './changes'
import { items } from './db'
import { syncNow } from './phonesync'
import { Body, Card, colors, Link, Note, Title } from './ui'

const money = (n: number, currency: string): string => {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(n)
  } catch {
    return `${n} ${currency}`
  }
}
const day = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

/** The deals tab: sponsorships you are tracking, with what is still owed. Change a deal's stage here and it syncs. */
export default function Deals() {
  const changed = useChanged()
  const [open, setOpen] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const deals = useMemo(() => {
    void changed
    return listDeals(items)
  }, [changed])
  const owed = useMemo(() => [...outstanding(deals)], [deals])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    await syncNow()
    setRefreshing(false)
  }, [])
  useEffect(() => void refresh(), [refresh])

  const move = (d: Deal, stage: Deal['stage']) => {
    setDealStage(items, d.id, stage, Date.now())
    notifyChanged()
    void syncNow()
  }

  return (
    <Body refreshing={refreshing} onRefresh={() => void refresh()}>
      <Title>Deals</Title>
      {owed.length > 0 && <Note>Still to come: {owed.map(([c, n]) => money(n, c)).join(', ')}</Note>}
      {deals.length === 0 && <Note>No deals yet. Deals you track on the desktop app appear here; pull down to sync.</Note>}
      {deals.map((d) => (
        <Card key={d.id} onPress={() => setOpen(open === d.id ? null : d.id)}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
            <Text style={{ color: colors.text, fontSize: 16, flex: 1 }}>{d.brand}</Text>
            <Text style={{ color: colors.warn }}>{d.stage}</Text>
          </View>
          <Text style={{ color: colors.muted, fontSize: 13 }}>
            {d.rate !== null ? money(d.rate, d.currency) : 'No rate'}
            {d.dueDate ? ` · due ${day.format(d.dueDate)}` : ''}
          </Text>
          {open === d.id && (
            <View style={{ gap: 6, paddingTop: 8 }}>
              {d.deliverables !== '' && <Text style={{ color: colors.soft }}>{d.deliverables}</Text>}
              {d.notes !== '' && <Text style={{ color: colors.muted }}>{d.notes}</Text>}
              {d.paidAt && <Text style={{ color: colors.muted }}>Paid {day.format(d.paidAt)}</Text>}
              <Note>Move to</Note>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14 }}>
                {DEAL_STAGES.filter((x) => x !== d.stage).map((x) => (
                  <Link key={x} onPress={() => move(d, x)}>
                    {x}
                  </Link>
                ))}
              </View>
            </View>
          )}
        </Card>
      ))}
    </Body>
  )
}
