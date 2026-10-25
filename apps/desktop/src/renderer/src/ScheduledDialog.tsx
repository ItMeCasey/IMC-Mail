import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Pencil } from 'lucide-react'
import type { Draft } from '@imc/core'
import { useOutbox } from './hooks'
import { describeTime } from './schedule'

/** Messages waiting for a time you chose. Editing one takes it back into the composer. */
export default function ScheduledDialog({
  onEdit,
  onClose
}: {
  onEdit: (d: Draft) => void
  onClose: () => void
}) {
  const qc = useQueryClient()
  const dialog = useRef<HTMLDialogElement>(null)
  const outbox = useOutbox()
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  const items = (outbox.data ?? []).filter((i) => i.scheduled && i.state === 'queued')

  const edit = async (id: string) => {
    const d = await window.imc.invoke('compose:undo', { outboxId: id })
    await qc.invalidateQueries({ queryKey: ['outbox'] })
    dialog.current?.close()
    if (d) onEdit(d)
  }

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-labelledby="sched-title"
      className="m-auto w-md max-w-[calc(100vw-2rem)] rounded-md border border-line-strong bg-raised p-0 text-ink"
    >
      <div className="p-6">
        <h2 id="sched-title" className="mb-3 text-lg font-semibold">
          Scheduled
        </h2>
        {items.length === 0 && <p className="text-ink-2">Nothing is scheduled.</p>}
        <ul className="max-h-80 overflow-y-auto border-t border-line">
          {items.map((i) => (
            <li key={i.id} className="flex items-center gap-2 border-b border-line py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{i.subject || '(no subject)'}</span>
                <span className="block truncate text-sm text-ink-3">To {i.to.join(', ')}</span>
                <span className="num block text-sm text-ink-2">{describeTime(i.sendAt)}</span>
              </span>
              <button
                className="flex h-8 items-center gap-1.5 rounded-md border border-line-strong px-3 text-sm hover:bg-hover"
                onClick={() => void edit(i.id)}
                title="Take it back into the composer. It will not send until you schedule it again."
              >
                <Pencil size={13} strokeWidth={1.75} aria-hidden />
                Edit
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex justify-end">
          <button className="h-9 rounded-md border border-line-strong px-4 hover:bg-hover" onClick={() => dialog.current?.close()}>
            Close
          </button>
        </div>
      </div>
    </dialog>
  )
}
