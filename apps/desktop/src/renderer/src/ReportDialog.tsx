import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

/**
 * "Report a problem": shows exactly what would go into a GitHub issue, then opens GitHub's new
 * issue page in your browser. Nothing is sent from here; you review and submit it there.
 */
export default function ReportDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [note, setNote] = useState('')
  const [includeErrors, setIncludeErrors] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<{ url: string; duplicate: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const summary = useQuery({ queryKey: ['report-summary'], queryFn: () => window.imc.invoke('report:summary') })
  const preview = useQuery({
    queryKey: ['report-preview', note, includeErrors],
    queryFn: () => window.imc.invoke('report:preview', { note, includeErrors }),
    placeholderData: (prev) => prev
  })
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  const errors = summary.data?.errors ?? 0
  const relay = summary.data?.relay ?? false

  const send = async () => {
    setError(null)
    setBusy(true)
    try {
      setSent(await window.imc.invoke('report:send', { note, includeErrors: includeErrors && errors > 0 }))
    } catch (e) {
      setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }

  const open = async () => {
    setError(null)
    try {
      await window.imc.invoke('report:open', { note, includeErrors: includeErrors && errors > 0 })
      dialog.current?.close()
    } catch (e) {
      setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-labelledby="report-title"
      className="m-auto w-xl max-w-[calc(100vw-2rem)] rounded-md border border-line-strong bg-raised p-0 text-ink"
    >
      <div className="max-h-[calc(100vh-4rem)] space-y-3 overflow-y-auto p-6">
        <h2 id="report-title" className="text-lg font-semibold">
          Report a problem
        </h2>
        <p className="text-sm text-ink-3">
          {relay
            ? 'Sending files this as an issue on the project\'s GitHub page. Only the text below is sent: no mail, addresses or passwords.'
            : 'This opens a pre-filled issue on GitHub in your browser. You can read and change it there before you submit. Nothing is sent from the app.'}
        </p>
        <label className="block text-sm text-ink-2">
          What happened?
          <textarea
            autoFocus
            value={note}
            rows={4}
            maxLength={5000}
            onChange={(e) => setNote(e.target.value)}
            className="mt-1 block w-full rounded-md border border-line-strong bg-sheet px-2.5 py-1.5 text-ink"
          />
        </label>
        {errors > 0 && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={includeErrors} onChange={(e) => setIncludeErrors(e.target.checked)} />
            Include the {errors === 1 ? 'error' : `${Math.min(errors, 5)} most recent errors`} the app logged
          </label>
        )}
        <div>
          <p className="mb-1 text-sm text-ink-2">What will be in the issue</p>
          <pre className="max-h-56 overflow-auto rounded-md border border-line bg-sheet p-3 font-mono text-xs break-words whitespace-pre-wrap">
            {preview.data?.body ?? ''}
          </pre>
        </div>
        {error && (
          <p role="alert" className="text-alert">
            {error}
          </p>
        )}
        {sent && (
          <p role="status" className="text-sm text-ink-2">
            {sent.duplicate ? 'Thanks. This was already reported, so yours was added to it. ' : 'Thanks, your report was sent. '}
            <a href={sent.url} target="_blank" rel="noreferrer noopener" className="text-accent underline underline-offset-2">
              View it on GitHub
            </a>
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button className="h-9 rounded-md border border-line-strong px-4 hover:bg-hover" onClick={() => dialog.current?.close()}>
            {sent ? 'Close' : 'Cancel'}
          </button>
          {!sent && relay && (
            <button className="h-9 rounded-md border border-line-strong px-4 hover:bg-hover" onClick={() => void open()}>
              Open on GitHub instead
            </button>
          )}
          {!sent &&
            (relay ? (
              <button disabled={busy} className="h-9 rounded-md bg-accent px-4 font-medium text-on-accent hover:bg-accent-hover disabled:opacity-60" onClick={() => void send()}>
                {busy ? 'Sending…' : 'Send report'}
              </button>
            ) : (
              <button className="h-9 rounded-md bg-accent px-4 font-medium text-on-accent hover:bg-accent-hover" onClick={() => void open()}>
                Open on GitHub
              </button>
            ))}
        </div>
      </div>
    </dialog>
  )
}
