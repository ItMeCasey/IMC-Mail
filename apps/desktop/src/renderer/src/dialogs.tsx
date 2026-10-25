import { useEffect, useRef, useState } from 'react'
import { TriangleAlert } from 'lucide-react'

/**
 * In-app replacements for the browser's confirm() and prompt(), which look out of place and, in
 * Electron, prompt() does not work at all. Call askConfirm / askText from anywhere; <DialogHost />
 * (mounted once in the app) shows them, one at a time.
 */

export interface ConfirmOptions {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  /** A destructive action: the confirm button is drawn as a warning and Cancel has the focus. */
  danger?: boolean
}

export interface TextOptions {
  title: string
  message?: string
  label: string
  initial?: string
  confirmLabel?: string
  /** Let an empty answer through (as ""), e.g. to clear a link. Otherwise empty is not allowed. */
  allowEmpty?: boolean
}

type Request =
  | { kind: 'confirm'; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: 'text'; opts: TextOptions; resolve: (v: string | null) => void }

let enqueue: ((r: Request) => void) | null = null

export function askConfirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    // With no host mounted (a test, say) fall back to the browser's own box.
    if (!enqueue) resolve(window.confirm(`${opts.title}\n\n${opts.message}`))
    else enqueue({ kind: 'confirm', opts, resolve })
  })
}

export function askText(opts: TextOptions): Promise<string | null> {
  return new Promise((resolve) => {
    if (!enqueue) resolve(null)
    else enqueue({ kind: 'text', opts, resolve })
  })
}

const secondary = 'h-9 rounded-md border border-line-strong px-4 text-ink hover:bg-hover'

function Box({ request, onDone }: { request: Request; onDone: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [text, setText] = useState(request.kind === 'text' ? (request.opts.initial ?? '') : '')
  const settled = useRef(false)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  /** Resolves once, whichever way the box closes (a button, Escape, or a click on the backdrop). */
  const finish = (value: boolean | string | null) => {
    if (settled.current) return
    settled.current = true
    if (request.kind === 'confirm') request.resolve(value === true)
    else request.resolve(typeof value === 'string' ? value : null)
    dialog.current?.close()
    onDone()
  }

  const danger = request.kind === 'confirm' && request.opts.danger
  const confirmLabel = request.opts.confirmLabel ?? (danger ? 'Delete' : 'OK')

  return (
    <dialog
      ref={dialog}
      aria-labelledby="ask-title"
      aria-describedby="ask-message"
      onCancel={(e) => {
        e.preventDefault()
        finish(request.kind === 'confirm' ? false : null)
      }}
      onClick={(e) => {
        if (e.target === dialog.current) finish(request.kind === 'confirm' ? false : null)
      }}
      className="m-auto w-96 max-w-[calc(100vw-2rem)] rounded-md border border-line-strong bg-raised p-0 text-ink"
    >
      <form
        className="space-y-4 p-6"
        onSubmit={(e) => {
          e.preventDefault()
          finish(request.kind === 'confirm' ? true : request.opts.allowEmpty ? text.trim() : text.trim() || null)
        }}
      >
        <div className="flex items-start gap-3">
          {danger && <TriangleAlert size={20} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0 text-alert" />}
          <div className="min-w-0 space-y-1">
            <h2 id="ask-title" className="text-lg font-semibold">
              {request.opts.title}
            </h2>
            {(request.kind === 'confirm' || request.opts.message) && (
              <p id="ask-message" className="leading-snug break-words text-ink-2">
                {request.kind === 'confirm' ? request.opts.message : request.opts.message}
              </p>
            )}
          </div>
        </div>

        {request.kind === 'text' && (
          <label className="block text-sm text-ink-2">
            {request.opts.label}
            <input
              autoFocus
              value={text}
              maxLength={200}
              onFocus={(e) => e.target.select()}
              onChange={(e) => setText(e.target.value)}
              className="mt-1 block h-9 w-full rounded-md border border-line-strong bg-sheet px-2.5 text-ink"
            />
          </label>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            autoFocus={danger}
            className={secondary}
            onClick={() => finish(request.kind === 'confirm' ? false : null)}
          >
            {request.kind === 'confirm' ? (request.opts.cancelLabel ?? 'Cancel') : 'Cancel'}
          </button>
          <button
            type="submit"
            disabled={request.kind === 'text' && !request.opts.allowEmpty && !text.trim()}
            autoFocus={request.kind === 'confirm' && !danger}
            className={
              danger
                ? 'h-9 rounded-md border border-alert px-4 font-medium text-alert hover:bg-hover'
                : 'h-9 rounded-md bg-accent px-4 font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50'
            }
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  )
}

export function DialogHost() {
  const [queue, setQueue] = useState<Request[]>([])
  useEffect(() => {
    enqueue = (r) => setQueue((q) => [...q, r])
    return () => {
      enqueue = null
    }
  }, [])
  const current = queue[0]
  // Keyed, so each request gets a fresh box (and fresh text state).
  return current ? <Box key={queue.length + current.opts.title} request={current} onDone={() => setQueue((q) => q.slice(1))} /> : null
}
