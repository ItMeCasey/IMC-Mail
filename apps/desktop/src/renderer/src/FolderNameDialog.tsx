import { useEffect, useRef, useState } from 'react'
import { cleanFolderName } from '@imc/core'

/** Asks for a folder name, and explains what is wrong with a name before anything is sent. */
export default function FolderNameDialog({
  title,
  where,
  initial = '',
  confirmLabel = 'Create folder',
  busyLabel = 'Creating…',
  onCreate,
  onClose
}: {
  title: string
  /** Where it will go, e.g. "Inside Inbox", shown under the title. */
  where: string
  initial?: string
  confirmLabel?: string
  busyLabel?: string
  onCreate: (name: string) => Promise<void>
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [name, setName] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  const submit = async () => {
    const clean = cleanFolderName(name)
    if (!clean.ok) return setError(clean.error)
    setBusy(true)
    setError(null)
    try {
      await onCreate(clean.name)
      dialog.current?.close()
    } catch (e) {
      setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-labelledby="folder-name-title"
      className="m-auto w-96 max-w-[calc(100vw-2rem)] rounded-md border border-line-strong bg-raised p-0 text-ink"
    >
      <form
        className="space-y-3 p-6"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div>
          <h2 id="folder-name-title" className="text-lg font-semibold">
            {title}
          </h2>
          <p className="text-sm text-ink-3">{where}</p>
        </div>
        <label className="block text-sm text-ink-2">
          Folder name
          <input
            autoFocus
            onFocus={(e) => e.target.select()}
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 block h-9 w-full rounded-md border border-line-strong bg-sheet px-2.5 text-ink"
          />
        </label>
        {error && (
          <p role="alert" className="text-alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="h-9 rounded-md border border-line-strong px-4 hover:bg-hover" onClick={() => dialog.current?.close()}>
            Cancel
          </button>
          <button disabled={busy} className="h-9 rounded-md bg-accent px-4 font-medium text-on-accent hover:bg-accent-hover disabled:opacity-60">
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  )
}
