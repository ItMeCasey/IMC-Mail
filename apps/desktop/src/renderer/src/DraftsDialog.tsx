import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import type { Account } from '@imc/core'
import { useDrafts } from './hooks'
import { tapeColor } from './tape'

const fmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export default function DraftsDialog({
  accounts,
  onOpen,
  onClose
}: {
  accounts: Account[]
  onOpen: (id: string) => void
  onClose: () => void
}) {
  const qc = useQueryClient()
  const dialog = useRef<HTMLDialogElement>(null)
  const drafts = useDrafts()
  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-labelledby="drafts-title"
      className="m-auto w-md max-w-[calc(100vw-2rem)] rounded-md border border-line-strong bg-raised p-0 text-ink"
    >
      <div className="p-6">
        <h2 id="drafts-title" className="mb-3 text-lg font-semibold">
          Drafts
        </h2>
        {drafts.data && drafts.data.length === 0 && (
          <p className="text-ink-2">No drafts. Anything you start writing is saved here automatically.</p>
        )}
        <ul className="max-h-80 overflow-y-auto border-t border-line">
          {drafts.data?.map((d) => (
            <li key={d.id} className="flex items-center border-b border-line">
              <button
                className="flex min-w-0 flex-1 items-center gap-3 px-1 py-2.5 text-left hover:bg-hover"
                onClick={() => {
                  dialog.current?.close()
                  onOpen(d.id)
                }}
              >
                <span
                  className="tape shrink-0"
                  style={{ background: tapeColor(accounts.find((a) => a.id === d.accountId)?.color) }}
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{d.subject || '(no subject)'}</span>
                  <span className="block truncate text-sm text-ink-3">
                    {d.to.length ? `To ${d.to.join(', ')}` : 'No recipients'}
                  </span>
                </span>
                <time className="num shrink-0 text-sm text-ink-3">{fmt.format(new Date(d.updatedAt))}</time>
              </button>
              <button
                aria-label={`Delete draft ${d.subject || '(no subject)'}`}
                title="Delete draft"
                className="grid size-8 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-hover hover:text-ink"
                onClick={() =>
                  void window.imc
                    .invoke('compose:discardDraft', { id: d.id })
                    .then(() => qc.invalidateQueries({ queryKey: ['drafts'] }))
                }
              >
                <Trash2 size={14} strokeWidth={1.75} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex justify-end">
          <button
            className="h-9 rounded-md border border-line-strong px-4 hover:bg-hover"
            onClick={() => dialog.current?.close()}
          >
            Close
          </button>
        </div>
      </div>
    </dialog>
  )
}
