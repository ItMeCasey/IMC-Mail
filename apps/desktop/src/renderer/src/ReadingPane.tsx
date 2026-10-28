import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Archive,
  Check,
  Handshake,
  ChevronDown,
  ChevronRight,
  ImageOff,
  Forward,
  FolderInput,
  Mail,
  MailOpen,
  Reply,
  ReplyAll,
  ShieldAlert,
  Trash2,
  Paperclip,
  Star,
  TriangleAlert,
  X
} from 'lucide-react'
import {
  canOpenAttachment,
  canPreviewAttachment,
  CATEGORY_LABELS,
  categorySchema,
  type Attachment,
  type AttachmentPreview,
  type Category,
  type Folder,
  type MessageAction,
  type MessageDetail,
  type ReplyMode,
  type Thread
} from '@imc/core'
import EmailFrame from './EmailFrame'
import InviteCard from './InviteCard'
import LabelMenu from './LabelMenu'
import { useLabels, useStreamerFeatures } from './hooks'
import PreviewDialog from './PreviewDialog'
import FollowUpMenu from './FollowUpMenu'
import SnoozeMenu from './SnoozeMenu'
import { describeTime } from './schedule'

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
  const [preview, setPreview] = useState<Exclude<AttachmentPreview, { kind: 'none' }> | null>(null)
  const openPdf = async () => {
    try {
      await window.imc.invoke('attachments:open', { messageId, attachmentId: a.id })
    } catch (e) {
      setState('error')
      setMsg(errText(e))
    }
  }
  const openPreview = async () => {
    try {
      const p = await window.imc.invoke('attachments:preview', { messageId, attachmentId: a.id })
      if (p.kind === 'none') {
        setState('error')
        setMsg('No preview for this file. Save it to open it.')
      } else setPreview(p)
    } catch (e) {
      setState('error')
      setMsg(errText(e))
    }
  }
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
      {canPreviewAttachment(a.mime, a.filename) && (
        <button type="button" className="self-start text-xs text-accent underline underline-offset-2 hover:text-accent-hover" onClick={() => void openPreview()}>
          Preview
        </button>
      )}
      {canOpenAttachment(a.mime, a.filename) && (
        <button type="button" className="self-start text-xs text-accent underline underline-offset-2 hover:text-accent-hover" onClick={() => void openPdf()}>
          Open PDF
        </button>
      )}
      {preview && <PreviewDialog name={a.filename} preview={preview} onClose={() => setPreview(null)} />}
      {state === 'saved' && <span className="text-xs text-ink-3">Saved</span>}
      {state === 'error' && <span className="text-xs text-alert">{msg}</span>}
    </span>
  )
}

/** The scam shield's warning for one message, with the reasons spelled out. */
function RiskBanner({
  m,
  linksOn,
  onEnableLinks,
  onSafe
}: {
  m: MessageDetail
  linksOn: boolean
  onEnableLinks: () => void
  onSafe: () => void
}) {
  if (m.risk.level === 'none') return null
  const danger = m.risk.level === 'danger'
  const Icon = danger ? ShieldAlert : TriangleAlert
  return (
    <div
      role={danger ? 'alert' : 'status'}
      className={`space-y-2 rounded-md border px-3 py-2.5 ${danger ? 'border-alert' : 'border-line-strong'}`}
    >
      <p className={`flex items-center gap-2 font-medium ${danger ? 'text-alert' : 'text-ink'}`}>
        <Icon size={16} strokeWidth={1.75} aria-hidden />
        {danger ? 'This looks like a scam' : 'Be careful with this message'}
      </p>
      <ul className="list-disc space-y-1 pl-6 text-sm leading-snug text-ink-2">
        {m.risk.reasons.map((r) => (
          <li key={r.code}>{r.text}</li>
        ))}
      </ul>
      <p className="text-sm text-ink-3">
        {danger
          ? "Don't click links, open attachments, or reply. Platforms and real sponsors never ask you to log in, pay, or download from an email."
          : 'Check these details before you click or reply.'}
      </p>
      <div className="flex flex-wrap gap-2">
        {danger && !linksOn && (
          <button className={textBtn} onClick={onEnableLinks}>
            Turn links on anyway
          </button>
        )}
        <button className={textBtn} onClick={onSafe}>
          This message is fine
        </button>
      </div>
    </div>
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
  const [linksOn, setLinksOn] = useState(false)
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
          <RiskBanner
            m={m}
            linksOn={linksOn}
            onEnableLinks={() => setLinksOn(true)}
            onSafe={() => {
              void window.imc.invoke('messages:markSafe', { id: m.id, safe: true }).then(() => qc.invalidateQueries())
            }}
          />

          {m.invite && <InviteCard messageId={m.id} invite={m.invite} />}

          {m.bodyState === 'ready' && (
            <EmailFrame id={m.id} allowImages allowLinks={linksOn} title={`Message from ${m.fromName || m.fromAddr}`} />
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
  onReply,
  onAct,
  folders,
  onTrackDeal,
  onSnooze,
  onFollowUp
}: {
  thread: Thread | undefined
  loading: boolean
  error: unknown
  onClose: () => void
  onReply: (messageId: string, mode: ReplyMode) => void
  onAct: (action: MessageAction, folderId?: string) => void
  folders: Folder[]
  onTrackDeal: (messageId: string) => void
  onSnooze: (until: number | null) => void
  onFollowUp: (at: number | null) => void
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
  const here = folders.find((f) => f.id === selected?.folderId)
  // In Trash or Junk the delete button erases for good instead of moving.
  const permanent = here?.role === 'trash' || here?.role === 'junk'
  const targets = folders.filter((f) => f.accountId === selected?.accountId && f.id !== selected?.folderId)
  const [moveOpen, setMoveOpen] = useState(false)
  const streamer = useStreamerFeatures()
  const [catOpen, setCatOpen] = useState(false)
  const catRoot = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!catOpen) return
    const away = (e: MouseEvent) => {
      if (!catRoot.current?.contains(e.target as Node)) setCatOpen(false)
    }
    window.addEventListener('mousedown', away)
    return () => window.removeEventListener('mousedown', away)
  }, [catOpen])
  const setCategory = async (category: Category | null) => {
    if (!selected) return
    setCatOpen(false)
    await window.imc.invoke('messages:setCategory', { id: selected.id, category })
    void qc.invalidateQueries()
  }
  const moveRoot = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!moveOpen) return
    const away = (e: MouseEvent) => {
      if (!moveRoot.current?.contains(e.target as Node)) setMoveOpen(false)
    }
    window.addEventListener('mousedown', away)
    return () => window.removeEventListener('mousedown', away)
  }, [moveOpen])

  const labels = useLabels()
  const setLabels = useMutation({
    mutationFn: (ids: string[]) => window.imc.invoke('messages:setLabels', { id: thread!.selectedId, labelIds: ids }),
    onSettled: () => void qc.invalidateQueries()
  })
  const createLabel = async (name: string) => {
    const l = await window.imc.invoke('labels:create', { name })
    await qc.invalidateQueries({ queryKey: ['labels'] })
    return l
  }

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
      <header className="flex shrink-0 flex-wrap items-start gap-x-2 gap-y-1 border-b border-line px-4 py-2">
        <div className="order-1 min-h-8 min-w-0 flex-1">
          <h2 className="truncate text-md font-semibold">
            {thread ? thread.subject || '(no subject)' : loading ? 'Opening…' : 'Message'}
          </h2>
          <div className="flex items-center gap-2 text-sm text-ink-3">
            {thread && thread.messages.length > 1 && (
              <span className="num">{thread.messages.length} messages</span>
            )}
            {selected?.labelIds.map((id) => {
              const l = labels.data?.find((x) => x.id === id)
              return l ? (
                <span key={id} className="rounded-sm border border-line-strong px-1.5 text-xs leading-4 text-ink-2">
                  {l.name}
                </span>
              ) : null
            })}
            {selected && streamer && (
              <span ref={catRoot} className="relative">
                <button
                  type="button"
                  aria-expanded={catOpen}
                  aria-label={`Category: ${CATEGORY_LABELS[selected.category]}. Change`}
                  onClick={() => setCatOpen((v) => !v)}
                  className="rounded-sm border border-line-strong px-1.5 text-xs leading-4 text-ink-2 hover:bg-hover hover:text-ink"
                >
                  {CATEGORY_LABELS[selected.category]}
                </button>
                {catOpen && (
                  <ul
                    role="menu"
                    aria-label="Category"
                    className="absolute top-full left-0 z-20 mt-1 w-48 rounded-md border border-line-strong bg-raised py-1 text-base text-ink"
                  >
                    {categorySchema.options.map((c) => (
                      <li key={c} role="none">
                        <button
                          role="menuitemradio"
                          aria-checked={selected.category === c}
                          onClick={() => void setCategory(c)}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-hover"
                        >
                          <span className="grid size-4 place-items-center">
                            {selected.category === c && <Check size={14} strokeWidth={1.75} aria-hidden />}
                          </span>
                          {CATEGORY_LABELS[c]}
                        </button>
                      </li>
                    ))}
                    {selected.categoryManual && (
                      <li role="none" className="mt-1 border-t border-line pt-1">
                        <button
                          role="menuitem"
                          onClick={() => void setCategory(null)}
                          className="block w-full px-3 py-1.5 text-left text-ink-2 hover:bg-hover"
                        >
                          Let the rules decide
                        </button>
                      </li>
                    )}
                  </ul>
                )}
              </span>
            )}
          </div>
        </div>
        {selected && (
          <div className="order-3 -ml-2 flex basis-full flex-wrap items-center gap-0.5">
            <button className={iconBtn} aria-label="Reply" title="Reply" onClick={() => onReply(selected.id, 'reply')}>
              <Reply size={16} strokeWidth={1.75} aria-hidden />
            </button>
            <button className={iconBtn} aria-label="Reply all" title="Reply all" onClick={() => onReply(selected.id, 'replyAll')}>
              <ReplyAll size={16} strokeWidth={1.75} aria-hidden />
            </button>
            <button className={iconBtn} aria-label="Forward" title="Forward" onClick={() => onReply(selected.id, 'forward')}>
              <Forward size={16} strokeWidth={1.75} aria-hidden />
            </button>
            {streamer && (
              <button
                className={iconBtn}
                aria-label="Track as deal"
                title="Track as sponsorship deal"
                onClick={() => onTrackDeal(selected.id)}
              >
                <Handshake size={16} strokeWidth={1.75} aria-hidden />
              </button>
            )}
            <span className="mx-1 h-5 w-px bg-line" aria-hidden />
            <button
              className={iconBtn}
              aria-label="Archive"
              title="Archive (E)"
              disabled={here?.role === 'archive' || here?.role === 'all'}
              onClick={() => onAct('archive')}
            >
              <Archive size={16} strokeWidth={1.75} aria-hidden />
            </button>
            <button
              className={iconBtn}
              aria-label={permanent ? 'Delete forever' : 'Move to Trash'}
              title={permanent ? 'Delete forever' : 'Move to Trash (#)'}
              onClick={() => onAct(permanent ? 'deleteForever' : 'trash')}
            >
              <Trash2 size={16} strokeWidth={1.75} aria-hidden />
            </button>
            <button
              className={iconBtn}
              aria-label="Report as junk"
              title="Report as junk (!)"
              disabled={here?.role === 'junk'}
              onClick={() => onAct('junk')}
            >
              <ShieldAlert size={16} strokeWidth={1.75} aria-hidden />
            </button>
            <span ref={moveRoot} className="relative">
              <button
                className={iconBtn}
                aria-label="Move to folder"
                aria-expanded={moveOpen}
                title="Move to folder"
                onClick={() => setMoveOpen((v) => !v)}
              >
                <FolderInput size={16} strokeWidth={1.75} aria-hidden />
              </button>
              {moveOpen && (
                <ul
                  role="menu"
                  aria-label="Move to folder"
                  className="absolute top-full right-0 z-20 mt-1 max-h-72 w-56 overflow-y-auto rounded-md border border-line-strong bg-raised py-1"
                >
                  {targets.length === 0 && <li className="px-3 py-1.5 text-sm text-ink-3">No other folders</li>}
                  {targets.map((f) => (
                    <li key={f.id} role="none">
                      <button
                        role="menuitem"
                        className="block w-full truncate px-3 py-1.5 text-left hover:bg-hover"
                        onClick={() => {
                          setMoveOpen(false)
                          onAct('move', f.id)
                        }}
                      >
                        {f.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </span>
            <LabelMenu className={iconBtn} labels={labels.data ?? []} selected={selected.labelIds} onChange={(ids) => setLabels.mutate(ids)} onCreate={createLabel} />
            <SnoozeMenu className={iconBtn} onSnooze={(t) => onSnooze(t)} />
            {here?.role === 'sent' && <FollowUpMenu className={iconBtn} onSet={(t) => onFollowUp(t)} />}
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
          </div>
        )}
        <button className={`${iconBtn} order-2`} aria-label="Close message" title="Close (Esc)" onClick={onClose}>
          <X size={16} strokeWidth={1.75} aria-hidden />
        </button>
      </header>

      {selected?.snoozedUntil != null && (
        <p role="status" className="flex items-center gap-3 border-b border-line px-4 py-2 text-sm text-ink-2">
          <span className="flex-1">
            Snoozed until <span className="num">{describeTime(selected.snoozedUntil)}</span>
          </span>
          <button className={textBtn} onClick={() => onSnooze(null)}>
            Bring it back now
          </button>
        </p>
      )}

      {selected?.followUpAt != null && (
        <p role="status" className="flex items-center gap-3 border-b border-line px-4 py-2 text-sm text-ink-2">
          <span className="flex-1">
            {selected.followUpAt > Date.now() ? 'Reminder if nobody replies: ' : 'No reply yet since '}
            <span className="num">{describeTime(selected.followUpAt)}</span>
          </span>
          <button className={textBtn} onClick={() => onFollowUp(null)}>
            {selected.followUpAt > Date.now() ? 'Clear reminder' : 'Done'}
          </button>
        </p>
      )}

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
