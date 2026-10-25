import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

/** Under a folder's list: downloads the next 200 older messages from the server. */
export default function LoadOlder({ folderId, onError }: { folderId: string; onError: (m: string) => void }) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const run = async () => {
    setBusy(true)
    setNote(null)
    try {
      const r = await window.imc.invoke('folders:loadOlder', { folderId })
      setNote(r.loaded === 0 ? 'Nothing older on the server.' : `Loaded ${r.loaded} older ${r.loaded === 1 ? 'message' : 'messages'}.`)
      setDone(!r.more)
      await qc.invalidateQueries()
    } catch (e) {
      onError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-3 border-t border-line px-4 py-2 text-sm">
      {!done && (
        <button className="h-8 rounded-md border border-line-strong px-3 text-ink hover:bg-hover disabled:opacity-50" disabled={busy} onClick={() => void run()}>
          {busy ? 'Loading…' : 'Load older mail'}
        </button>
      )}
      <span role="status" className="text-ink-3">{note ?? (done ? 'That is everything in this folder.' : '')}</span>
    </div>
  )
}
