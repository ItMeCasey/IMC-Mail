import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { CalendarClock, Download, Plus, TriangleAlert } from 'lucide-react'
import { DEAL_STAGES, type Deal, type DealStage } from '@imc/core'
import DealDialog from './DealDialog'
import { Private } from './streamsafe'

const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

const money = (n: number, currency: string) => {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(n)
  } catch {
    return `${n} ${currency}`
  }
}

/** "$4,000" for one currency, "$4,000 + €500" for a mix. */
const total = (deals: Deal[]): string => {
  const by = new Map<string, number>()
  for (const d of deals) if (d.rate !== null) by.set(d.currency, (by.get(d.currency) ?? 0) + d.rate)
  return [...by].map(([c, n]) => money(n, c)).join(' + ')
}

const startOfToday = () => new Date(new Date().setHours(0, 0, 0, 0)).getTime()
const OPEN: DealStage[] = ['lead', 'negotiating', 'contracted']

function Card({
  deal,
  hide,
  onOpen
}: {
  deal: Deal
  hide: boolean
  onOpen: () => void
}) {
  const overdue = deal.dueDate !== null && deal.dueDate < startOfToday() && OPEN.includes(deal.stage)
  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/deal', deal.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onClick={onOpen}
      className="block w-full space-y-1.5 border border-line bg-sheet p-3 text-left transition-colors duration-(--dur-fast) hover:bg-hover"
    >
      <span className="block truncate font-medium">
        <Private active={hide}>{deal.brand}</Private>
      </span>
      {deal.rate !== null && (
        <span className="num block text-ink-2">
          <Private active={hide}>{money(deal.rate, deal.currency)}</Private>
        </span>
      )}
      {deal.deliverables && (
        <span className="line-clamp-2 block text-sm text-ink-3">
          <Private active={hide}>{deal.deliverables}</Private>
        </span>
      )}
      {deal.dueDate !== null && (
        <span className={`flex items-center gap-1.5 text-sm ${overdue ? 'font-medium text-alert' : 'text-ink-3'}`}>
          {overdue ? (
            <TriangleAlert size={13} strokeWidth={1.75} aria-hidden />
          ) : (
            <CalendarClock size={13} strokeWidth={1.75} aria-hidden />
          )}
          <span className="num">
            {overdue ? 'Overdue · ' : 'Due '}
            {day.format(new Date(deal.dueDate))}
          </span>
        </span>
      )}
    </button>
  )
}

export default function DealsBoard({
  deals,
  hide,
  onOpenMessage,
  focusId,
  onFocused
}: {
  deals: Deal[]
  hide: boolean
  onOpenMessage: (messageId: string) => void
  /** A deal to open the moment the board appears (just created from an email). */
  focusId: string | null
  onFocused: () => void
}) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<string | null>(null)
  const [over, setOver] = useState<DealStage | null>(null)
  const [showPassed, setShowPassed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [exported, setExported] = useState<string | null>(null)

  const columns = useMemo(
    () => DEAL_STAGES.filter((s) => s.id !== 'passed' || showPassed),
    [showPassed]
  )
  const passed = deals.filter((d) => d.stage === 'passed').length
  const editingDeal = deals.find((d) => d.id === editing)
  useEffect(() => {
    if (focusId && deals.some((d) => d.id === focusId)) {
      setEditing(focusId)
      onFocused()
    }
  }, [focusId, deals, onFocused])

  const move = async (id: string, stage: DealStage) => {
    const d = deals.find((x) => x.id === id)
    if (!d || d.stage === stage) return
    setError(null)
    // Optimistic: the card jumps columns at once; a refusal puts it back.
    qc.setQueryData<Deal[]>(['deals'], (old) => old?.map((x) => (x.id === id ? { ...x, stage } : x)))
    try {
      await window.imc.invoke('deals:update', { id, patch: { stage } })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      await qc.invalidateQueries({ queryKey: ['deals'] })
    }
  }

  const create = async () => {
    const d = await window.imc.invoke('deals:create', { patch: { brand: 'New deal' } })
    await qc.invalidateQueries({ queryKey: ['deals'] })
    setEditing(d.id)
  }

  return (
    <section aria-label="Sponsorship board" className="flex min-w-0 flex-1 flex-col bg-sheet">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
        <h1 className="text-md font-semibold">Sponsorship board</h1>
        <span className="num text-sm text-ink-3">{deals.filter((d) => d.stage !== 'passed').length === 1 ? "1 deal" : `${deals.filter((d) => d.stage !== 'passed').length} deals`}</span>
        <span className="flex-1" />
        {passed > 0 && (
          <button className="text-sm text-accent underline underline-offset-2 hover:text-accent-hover" onClick={() => setShowPassed((v) => !v)}>
            {showPassed ? 'Hide passed' : `Show passed (${passed})`}
          </button>
        )}
        {deals.length > 0 && (
          <button
            onClick={() => {
              setError(null)
              void window.imc
                .invoke('deals:exportCsv')
                .then((r) => setExported(r.saved))
                .catch((e) => setError(e instanceof Error ? e.message : String(e)))
            }}
            className="flex h-8 items-center gap-1.5 rounded-md border border-line-strong px-3 hover:bg-hover"
            title="Save every deal as a spreadsheet (CSV)"
          >
            <Download size={14} strokeWidth={1.75} aria-hidden />
            Export CSV
          </button>
        )}
        <button
          onClick={() => void create()}
          className="flex h-8 items-center gap-1.5 rounded-md border border-line-strong px-3 hover:bg-hover"
        >
          <Plus size={14} strokeWidth={1.75} aria-hidden />
          New deal
        </button>
      </header>

      {exported && (
        <p role="status" className="border-b border-line px-4 py-2 text-sm text-ink-2">
          Saved to {exported}
        </p>
      )}

      {error && (
        <p role="alert" className="border-b border-line px-4 py-2 text-sm text-alert">
          {error}
        </p>
      )}

      {deals.length === 0 ? (
        <div className="grid flex-1 place-items-center p-8">
          <div className="max-w-sm space-y-2">
            <h2 className="text-lg font-semibold">No deals yet</h2>
            <p className="leading-(--leading-prose) text-ink-2">
              Open a sponsorship email and choose “Track as deal”, or start one here. Cards move
              from Lead to Paid as you work, and the board keeps the rate and deadline next to the
              thread.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 divide-x divide-line overflow-x-auto">
          {columns.map((col) => {
            const cards = deals.filter((d) => d.stage === col.id)
            return (
              <div
                key={col.id}
                role="group"
                aria-label={col.label}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes('text/deal')) {
                    e.preventDefault()
                    setOver(col.id)
                  }
                }}
                onDragLeave={() => setOver((o) => (o === col.id ? null : o))}
                onDrop={(e) => {
                  e.preventDefault()
                  setOver(null)
                  const id = e.dataTransfer.getData('text/deal')
                  if (id) void move(id, col.id)
                }}
                className={`flex min-w-52 flex-1 flex-col transition-colors duration-(--dur-fast) ${over === col.id ? 'bg-selected' : 'bg-rail'}`}
              >
                <div className="flex h-9 shrink-0 items-baseline gap-2 border-b border-line px-3 pt-2">
                  <h2 className="text-sm font-medium">{col.label}</h2>
                  <span className="num text-sm text-ink-3">{cards.length}</span>
                  <span className="num ml-auto truncate text-sm text-ink-3">
                    <Private active={hide}>{total(cards)}</Private>
                  </span>
                </div>
                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
                  {cards.map((d) => (
                    <div key={d.id}>
                      <Card deal={d} hide={hide} onOpen={() => setEditing(d.id)} />
                      <label className="sr-only" htmlFor={`stage-${d.id}`}>
                        Move {hide ? 'deal' : d.brand} to
                      </label>
                      <select
                        id={`stage-${d.id}`}
                        value={d.stage}
                        onChange={(e) => void move(d.id, e.target.value as DealStage)}
                        className="sr-only focus:not-sr-only focus:mt-1 focus:h-7 focus:w-full focus:rounded-sm focus:border focus:border-line-strong focus:bg-sheet focus:px-2 focus:text-sm"
                      >
                        {DEAL_STAGES.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {editingDeal && (
        <DealDialog
          key={editingDeal.id}
          deal={editingDeal}
          onClose={() => setEditing(null)}
          onOpenMessage={onOpenMessage}
        />
      )}
    </section>
  )
}
