import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { TriangleAlert } from 'lucide-react'
import type { Draft, OutboxItem } from '@imc/core'
import { useOutbox } from './hooks'

const btn =
  'h-8 rounded-md border border-line-strong px-3 text-sm text-ink transition-colors duration-(--dur-fast) hover:bg-hover'

/** Sent confirmations stay a few seconds; queued, sending, and failed items stay until resolved. */
const SENT_VISIBLE_MS = 4000

function Row({ item, now, onUndo }: { item: OutboxItem; now: number; onUndo: (id: string) => void }) {
  const to = item.to[0] ? `${item.to[0]}${item.to.length > 1 ? ` +${item.to.length - 1}` : ''}` : ''
  const secs = Math.max(0, Math.ceil((item.sendAt - now) / 1000))

  if (item.state === 'failed') {
    return (
      <div role="alert" className="flex items-center gap-3">
        <TriangleAlert size={16} strokeWidth={1.75} className="shrink-0 text-alert" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate">Could not send “{item.subject || '(no subject)'}”</span>
          <span className="block truncate text-sm text-alert">{item.error}</span>
        </span>
        <button className={btn} onClick={() => onUndo(item.id)}>
          Edit
        </button>
      </div>
    )
  }
  if (item.state === 'queued' && secs > 0) {
    return (
      <div role="status" className="flex items-center gap-3">
        <span className="min-w-0 flex-1 truncate">
          Sending to {to} in <span className="num">{secs}</span>s
        </span>
        <button className={btn} onClick={() => onUndo(item.id)}>
          Undo
        </button>
      </div>
    )
  }
  return (
    <div role="status" className="flex items-center gap-3">
      <span className="min-w-0 flex-1 truncate">
        {item.state === 'sent' ? `Sent to ${to}` : `Sending to ${to}`}
      </span>
    </div>
  )
}

export default function OutboxToast({ onEdit }: { onEdit: (draft: Draft) => void }) {
  const qc = useQueryClient()
  const outbox = useOutbox()
  const [now, setNow] = useState(Date.now())

  const items = (outbox.data ?? []).filter(
    (i) => i.state !== 'sent' || now - i.sendAt < SENT_VISIBLE_MS
  )

  // Tick for the countdown, and again to retire "Sent" confirmations.
  useEffect(() => {
    if (items.length === 0) return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [items.length])

  const undo = async (id: string) => {
    const draft = await window.imc.invoke('compose:undo', { outboxId: id })
    await qc.invalidateQueries({ queryKey: ['outbox'] })
    if (draft) onEdit(draft)
  }

  if (items.length === 0) return null
  return (
    <div className="fixed bottom-4 left-1/2 z-30 w-[28rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 space-y-3 rounded-md border border-line-strong bg-raised px-4 py-3">
      {items.map((i) => (
        <Row key={i.id} item={i} now={now} onUndo={(id) => void undo(id)} />
      ))}
    </div>
  )
}
