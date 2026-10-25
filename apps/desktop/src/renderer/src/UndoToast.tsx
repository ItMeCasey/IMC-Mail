import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { UndoMove } from '@imc/core'

const SHOW_MS = 8000

/** "Archived. Undo" for a few seconds after a move. Undo asks the server to put the message back. */
export default function UndoToast({
  undo,
  onDone,
  onError
}: {
  undo: UndoMove
  onDone: () => void
  onError: (message: string) => void
}) {
  const qc = useQueryClient()
  useEffect(() => {
    const t = setTimeout(onDone, SHOW_MS)
    return () => clearTimeout(t)
  }, [onDone])

  const run = async () => {
    onDone()
    try {
      await window.imc.invoke('messages:undoMove', undo)
    } catch (e) {
      onError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      await qc.invalidateQueries()
    }
  }

  return (
    <div
      role="status"
      className="fixed bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-4 rounded-md border border-line-strong bg-raised px-4 py-2.5 text-ink"
    >
      <span>{undo.label}</span>
      <button className="font-medium text-accent underline underline-offset-2 hover:text-accent-hover" onClick={() => void run()}>
        Undo
      </button>
    </div>
  )
}
