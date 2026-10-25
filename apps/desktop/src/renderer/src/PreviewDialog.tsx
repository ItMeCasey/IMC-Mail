import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import type { AttachmentPreview } from '@imc/core'

/** An image or text attachment shown in a dialog. Images load from a data URL; text is plain text. */
export default function PreviewDialog({
  name,
  preview,
  onClose
}: {
  name: string
  preview: Exclude<AttachmentPreview, { kind: 'none' }>
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-label={`Preview of ${name}`}
      className="m-auto max-h-[calc(100vh-3rem)] w-4xl max-w-[calc(100vw-2rem)] rounded-md border border-line-strong bg-raised p-0 text-ink"
    >
      <div className="flex h-11 items-center gap-2 border-b border-line px-4">
        <h2 className="min-w-0 flex-1 truncate font-medium">{name}</h2>
        <button className="grid size-8 place-items-center rounded-md text-ink-2 hover:bg-hover" aria-label="Close preview" onClick={() => dialog.current?.close()}>
          <X size={16} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      <div className="max-h-[calc(100vh-8rem)] overflow-auto p-4">
        {preview.kind === 'image' ? (
          <img src={preview.dataUrl} alt={name} className="mx-auto max-h-[70vh] max-w-full object-contain" />
        ) : (
          <>
            <pre className="font-mono text-sm break-words whitespace-pre-wrap">{preview.text}</pre>
            {preview.truncated && <p className="mt-3 text-sm text-ink-3">Showing the first 200 KB. Save the file to see the rest.</p>}
          </>
        )}
      </div>
    </dialog>
  )
}
