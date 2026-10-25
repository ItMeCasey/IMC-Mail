import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ChevronDown,
  ChevronRight,
  ImageOff,
  Forward,
  Mail,
  MailOpen,
  Reply,
  ReplyAll,
  Paperclip,
  Star,
  TriangleAlert,
  X
} from 'lucide-react'
import type { Attachment, MessageDetail, ReplyMode, Thread } from '@imc/core'
import EmailFrame from './EmailFrame'

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

const formatBytes = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`

const iconBtn =
  'grid size-8 place-items-center rounded-md text-ink-2 transition-colors duration-(--dur-fast) hover:bg-hover hover:text-ink disabled:opacity-50'
const textBtn =
  'h-7 rounded-md border border-line-strong px-3 text-sm text-ink transition-colors duration-(--dur-fast) hover:bg-hover'

const errText = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    ''
  )

function AttachmentChip({ messageId, a }: { messageId: string; a: Attachment }) {
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [msg, setMsg] = useState('')
  const save = async () => {
    setState('saving')
    try {
      const r = await window.imc.invoke('attachments:save', { messageId, attachmentId: a.id })
      setState(r.saved ? 'saved' : 'idle')
      setMsg(r.saved ?? '')
    } catch (e) {
      setState('error')
      setMsg(errText(e))
    }
  }
  return (
    <span className="flex flex-col gap-0.5">
      <button
        type="button"
        onClick={() => void save()}
        disabled={state === 'saving'}
        title={`Save ${a.filename}`}
        className="flex h-8 max-w-64 items-center gap-2 rounded-md border border-line-strong px-2.5 text-sm text-ink transition-colors duration-(--dur-fast) hover:bg-hover disabled:opacity-60"
      >
        <Paperclip size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
        <span className="truncate">{a.filename}</span>
        <span className="num shrink-0 text-ink-3">{formatBytes(a.size)}</span>
      </button>
      {state === 'saved' && <span className="text-xs text-ink-3">Saved</span>}
      {state === 'error' && <span className="text-xs text-alert">{msg}</span>}
    </span>
  )
}

function MessageBlock({
  m,
  open,
  onToggle,
  onNeedBody
}: {
  m: MessageDetail
  open: boolean
  onToggle: () => void
  onNeedBody: () => void
}) {
  const qc = useQueryClient()
  const [showImages, setShowImages] = useState(false)
  const allowImages = showImages || m.imagesAllowed
  const always = useMutation({
    mutationFn: () => window.imc.invoke('senders:allowImages', { address: m.fromAddr }),
    onSuccess: () => void qc.invalidateQueries()
  })
  const Chevron = open ? ChevronDown : ChevronRight

  return (
    <article className="border-b border-line">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          if (!open && m.bodyState !== 'ready') onNeedBody()
          onToggle()
        }}
        className="flex w-full items-start gap-2 px-4 py-3 text-left transition-colors duration-(--dur-fast) hover:bg-hover"
      >
        <Chevron size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-ink-3" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className={`truncate ${m.unread ? 'font-semibold' : 'font-medium'}`}>
              {m.fromName || m.fromAddr}
            </span>
            {m.fromName && <span className="truncate text-sm text-ink-3">{m.fromAddr}</span>}
            <time className="num ml-auto shrink-0 text-sm text-ink-3">
              {m.date ? dateFmt.format(new Date(m.date)) : ''}
            </time>
          </span>
          {open ? (
            <span className="mt-0.5 block truncate text-sm text-ink-3">
              to {m.to || 'undisclosed recipients'}
              {m.cc ? ` · cc ${m.cc}` : ''}
            </span>
          ) : (
            <span className="mt-0.5 block truncate text-sm text-ink-2">
              {m.snippet || (m.bodyState === 'ready' ? '(no text)' : 'Not downloaded yet')}
            </span>
          )}
        </span>
      </button>

      {open && (
        <div className="space-y-3 px-4 pb-4 pl-10">
          {m.bodyState === 'ready' && m.blockedImages > 0 && !allowImages && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-line-strong px-3 py-2 text-sm">
              <ImageOff size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-ink-2" />
              <span className="flex-1 text-ink-2">
                {m.blockedImages} remote {m.blockedImages === 1 ? 'image is' : 'images are'} hidden
                to keep the sender from seeing when you read this.
              </span>
              <button className={textBtn} onClick={() => setShowImages(true)}>
                Show images
              </button>
              <button className={textBtn} onClick={() => always.mutate()}>
                Always for this sender
              </button>
            </div>
          )}

          {m.bodyState === 'ready' && (
            <EmailFrame id={m.id} allowImages={allowImages} title={`Message from ${m.fromName || m.fromAddr}`} />
          )}
          {m.bodyState === 'missing' && <p className="text-sm text-ink-3">Downloading…</p>}
          {m.bodyState === 'error' && (
            <p role="alert" className="flex items-start gap-2 text-alert">
              <TriangleAlert size={16} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden />
              <span className="flex-1">{m.error}</span>
              <button className={textBtn} onClick={onNeedBody}>
                Retry
              </button>
            </p>
          )}

          {m.attachments.length > 0 && (
            <div className="flex flex-wrap gap-2" aria-label="Attachments">
              {m.attachments.map((a) => (
                <AttachmentChip key={a.id} messageId={m.id} a={a} />
              ))}
            </div>
          )}
        </div>
      )}
    </article>
  )
}

export default function ReadingPane({
  thread,
  loading,
  error,
  onClose,
  onReply
}: {
  thread: Thread | undefined
  loading: boolean
  error: unknown
  onClose: () => void
  onReply: (messageId: string, mode: ReplyMode) => void
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [openFor, setOpenFor] = useState<string | null>(null)

  // Reset which messages are expanded whenever a different conversation is shown.
  if (thread && openFor !== thread.selectedId) {
    const newest = thread.messages[thread.messages.length - 1]?.id
    setOpenFor(thread.selectedId)
    setOpen({ [thread.selectedId]: true, ...(newest ? { [newest]: true } : {}) })
  }

  const selected = thread?.messages.find((m) => m.id === thread.selectedId)

  const flags = useMutation({
    mutationFn: (v: { seen?: boolean; flagged?: boolean }) =>
      window.imc.invoke('messages:setFlags', { id: thread!.selectedId, ...v }),
    onSettled: () => void qc.invalidateQueries()
  })
  const loadBody = useMutation({
    mutationFn: (id: string) => window.imc.invoke('messages:loadBody', { id }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['thread'] })
  })

  return (
    <section aria-label="Message" className="flex min-w-0 flex-1 flex-col bg-sheet">
      <header className="flex min-h-12 shrink-0 items-center gap-2 border-b border-line px-4 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-md font-semibold">
            {thread ? thread.subject || '(no subject)' : loading ? 'Opening…' : 'Message'}
          </h2>
          {thread && thread.messages.length > 1 && (
            <p className="num text-sm text-ink-3">{thread.messages.length} messages</p>
          )}
        </div>
        {selected && (
          <>
            <button className={iconBtn} aria-label="Reply" title="Reply" onClick={() => onReply(selected.id, 'reply')}>
              <Reply size={16} strokeWidth={1.75} aria-hidden />
            </button>
            <button className={iconBtn} aria-label="Reply all" title="Reply all" onClick={() => onReply(selected.id, 'replyAll')}>
              <ReplyAll size={16} strokeWidth={1.75} aria-hidden />
            </button>
            <button className={iconBtn} aria-label="Forward" title="Forward" onClick={() => onReply(selected.id, 'forward')}>
              <Forward size={16} strokeWidth={1.75} aria-hidden />
            </button>
            <span className="mx-1 h-5 w-px bg-line" aria-hidden />
            <button
              className={iconBtn}
              aria-label={selected.unread ? 'Mark as read' : 'Mark as unread'}
              title={selected.unread ? 'Mark as read' : 'Mark as unread'}
              onClick={() => flags.mutate({ seen: selected.unread })}
            >
              {selected.unread ? (
                <MailOpen size={16} strokeWidth={1.75} aria-hidden />
              ) : (
                <Mail size={16} strokeWidth={1.75} aria-hidden />
              )}
            </button>
            <button
              className={iconBtn}
              aria-label={selected.starred ? 'Remove star' : 'Add star'}
              aria-pressed={selected.starred}
              title={selected.starred ? 'Remove star' : 'Add star'}
              onClick={() => flags.mutate({ flagged: !selected.starred })}
            >
              <Star
                size={16}
                strokeWidth={1.75}
                className={selected.starred ? 'fill-current text-ink' : ''}
                aria-hidden
              />
            </button>
          </>
        )}
        <button className={iconBtn} aria-label="Close message" title="Close (Esc)" onClick={onClose}>
          <X size={16} strokeWidth={1.75} aria-hidden />
        </button>
      </header>

      {flags.isError && (
        <p role="alert" className="border-b border-line px-4 py-2 text-sm text-alert">
          {errText(flags.error)}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <p role="alert" className="flex items-start gap-2 p-4 text-alert">
            <TriangleAlert size={16} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden />
            {errText(error)}
          </p>
        ) : !thread ? (
          <div className="space-y-3 p-4" aria-hidden>
            {[70, 90, 55].map((w) => (
              <div key={w} className="h-3 rounded-sm bg-hover" style={{ width: `${w}%` }} />
            ))}
          </div>
        ) : (
          thread.messages.map((m) => (
            <MessageBlock
              key={m.id}
              m={m}
              open={!!open[m.id]}
              onToggle={() => setOpen((o) => ({ ...o, [m.id]: !o[m.id] }))}
              onNeedBody={() => loadBody.mutate(m.id)}
            />
          ))
        )}
      </div>
    </section>
  )
}
