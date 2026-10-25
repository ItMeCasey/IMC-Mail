import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { TriangleAlert } from 'lucide-react'
import { DEAL_STAGES, type Deal, type DealStage } from '@imc/core'

const field =
  'h-9 w-full rounded-md border border-line-strong bg-sheet px-3 text-ink focus-visible:border-accent focus-visible:outline-offset-0'
const area =
  'w-full resize-none rounded-md border border-line-strong bg-sheet px-3 py-2 text-ink focus-visible:border-accent focus-visible:outline-offset-0'
const label = 'mb-1 block text-sm text-ink-2'

/** Epoch ms <-> the YYYY-MM-DD an <input type="date"> speaks, in local time. */
export const toDateInput = (ms: number | null): string => {
  if (ms === null) return ''
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
export const fromDateInput = (v: string): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : null
}

const errText = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export default function DealDialog({
  deal,
  onClose,
  onOpenMessage
}: {
  deal: Deal
  onClose: () => void
  onOpenMessage: (messageId: string) => void
}) {
  const qc = useQueryClient()
  const dialog = useRef<HTMLDialogElement>(null)
  const [brand, setBrand] = useState(deal.brand)
  const [stage, setStage] = useState<DealStage>(deal.stage)
  const [rate, setRate] = useState(deal.rate === null ? '' : String(deal.rate))
  const [currency, setCurrency] = useState(deal.currency)
  const [due, setDue] = useState(toDateInput(deal.dueDate))
  const [deliverables, setDeliverables] = useState(deal.deliverables)
  const [notes, setNotes] = useState(deal.notes)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    const parsedRate = rate.trim() === '' ? null : Number(rate.replace(/,/g, ''))
    if (parsedRate !== null && (Number.isNaN(parsedRate) || parsedRate < 0)) {
      setError('Rate must be a number, like 4000')
      return
    }
    try {
      await window.imc.invoke('deals:update', {
        id: deal.id,
        patch: {
          brand,
          stage,
          rate: parsedRate,
          currency,
          dueDate: fromDateInput(due),
          deliverables,
          notes
        }
      })
      await qc.invalidateQueries({ queryKey: ['deals'] })
      dialog.current?.close()
    } catch (err) {
      setError(errText(err))
    }
  }

  const remove = async () => {
    if (!confirm(`Delete the ${deal.brand} deal? The email stays in your inbox.`)) return
    await window.imc.invoke('deals:delete', { id: deal.id })
    await qc.invalidateQueries({ queryKey: ['deals'] })
    dialog.current?.close()
  }

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-labelledby="deal-title"
      className="m-auto w-lg max-w-[calc(100vw-2rem)] rounded-md border border-line-strong bg-raised p-0 text-ink"
    >
      <form onSubmit={save} className="space-y-4 p-6">
        <h2 id="deal-title" className="text-lg font-semibold">
          Deal details
        </h2>

        <div className="grid grid-cols-[1fr_10rem] gap-3">
          <div>
            <label className={label} htmlFor="deal-brand">
              Brand
            </label>
            <input id="deal-brand" className={field} value={brand} onChange={(e) => setBrand(e.target.value)} required autoFocus />
          </div>
          <div>
            <label className={label} htmlFor="deal-stage">
              Stage
            </label>
            <select id="deal-stage" className={field} value={stage} onChange={(e) => setStage(e.target.value as DealStage)}>
              {DEAL_STAGES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-[1fr_6rem_1fr] gap-3">
          <div>
            <label className={label} htmlFor="deal-rate">
              Rate
            </label>
            <input id="deal-rate" className={`${field} num`} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="4000" />
          </div>
          <div>
            <label className={label} htmlFor="deal-cur">
              Currency
            </label>
            <input id="deal-cur" className={`${field} uppercase`} maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
          </div>
          <div>
            <label className={label} htmlFor="deal-due">
              Next deadline
            </label>
            <input id="deal-due" type="date" className={`${field} num`} value={due} onChange={(e) => setDue(e.target.value)} />
          </div>
        </div>

        <div>
          <label className={label} htmlFor="deal-del">
            Deliverables
          </label>
          <textarea id="deal-del" className={area} rows={2} value={deliverables} onChange={(e) => setDeliverables(e.target.value)} placeholder="2 streams, 1 short, usage rights for 90 days" />
        </div>
        <div>
          <label className={label} htmlFor="deal-notes">
            Notes
          </label>
          <textarea id="deal-notes" className={area} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>

        {error && (
          <p role="alert" className="flex items-start gap-2 rounded-md border border-alert px-3 py-2 text-alert">
            <TriangleAlert size={16} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden />
            {error}
          </p>
        )}

        <div className="flex items-center gap-2 pt-1">
          <button type="button" onClick={() => void remove()} className="h-9 rounded-md px-3 text-sm text-ink-2 hover:bg-hover hover:text-ink">
            Delete
          </button>
          {deal.messageId && (
            <button
              type="button"
              onClick={() => {
                dialog.current?.close()
                onOpenMessage(deal.messageId!)
              }}
              className="h-9 rounded-md px-3 text-sm text-ink-2 hover:bg-hover hover:text-ink"
            >
              Open the email
            </button>
          )}
          <span className="flex-1" />
          <button type="button" onClick={() => dialog.current?.close()} className="h-9 rounded-md border border-line-strong px-4 hover:bg-hover">
            Cancel
          </button>
          <button type="submit" className="h-9 rounded-md bg-accent px-4 font-medium text-on-accent hover:bg-accent-hover">
            Save
          </button>
        </div>
      </form>
    </dialog>
  )
}
