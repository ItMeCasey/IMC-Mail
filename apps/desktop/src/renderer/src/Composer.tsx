import { askConfirm, askText } from './dialogs'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Placeholder } from '@tiptap/extensions'
import {
  Bold,
  FileText,
  Italic,
  Link2,
  List,
  ListOrdered,
  Paperclip,
  Quote,
  Redo2,
  TriangleAlert,
  Underline as UnderlineIcon,
  Undo2,
  X,
  type LucideIcon
} from 'lucide-react'
import {
  fillTemplate,
  placeholdersIn,
  type Account,
  type Draft,
  type DraftAttachment,
  type Template
} from '@imc/core'
import { useMediaKit, useStreamerFeatures } from './hooks'
import { ScheduleMenu, TemplatesMenu } from './ComposerMenus'
import RecipientInput, { isValidRecipient } from './RecipientInput'
import { tapeColor } from './tape'

const errText = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    ''
  )

const formatBytes = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The signature block appended to a fresh message (plain text -> paragraphs). */
export const signatureHtml = (signature: string): string =>
  signature.trim() ? `<p></p><p>-- <br>${esc(signature.trim()).replace(/\n/g, '<br>')}</p>` : ''

const btn =
  'grid size-8 place-items-center rounded-md text-ink-2 transition-colors duration-(--dur-fast) hover:bg-hover hover:text-ink disabled:opacity-40'

function ToolButton({
  label,
  Icon,
  active,
  onClick,
  disabled
}: {
  label: string
  Icon: LucideIcon
  active?: boolean
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} // keep the editor selection
      onClick={onClick}
      className={`${btn} ${active ? 'bg-selected text-ink' : ''}`}
    >
      <Icon size={16} strokeWidth={1.75} aria-hidden />
    </button>
  )
}

export default function Composer({
  seed,
  accounts,
  onClose,
  onQueued
}: {
  seed: Draft
  accounts: Account[]
  onClose: () => void
  onQueued: () => void
}) {
  const qc = useQueryClient()
  const [accountId, setAccountId] = useState(seed.accountId)
  const [to, setTo] = useState(seed.to)
  const [cc, setCc] = useState(seed.cc)
  const [bcc, setBcc] = useState(seed.bcc)
  const [showCc, setShowCc] = useState(seed.cc.length > 0 || seed.bcc.length > 0)
  const [subject, setSubject] = useState(seed.subject)
  const [attachments, setAttachments] = useState<DraftAttachment[]>(seed.attachments)
  const [draftId, setDraftId] = useState(seed.id)
  const [html, setHtml] = useState(seed.html)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [sigOpen, setSigOpen] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const account = accounts.find((a) => a.id === accountId)
  const [signature, setSignature] = useState(account?.signature ?? '')

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
      Placeholder.configure({ placeholder: 'Write your message' })
    ],
    content: seed.html,
    editorProps: { attributes: { 'aria-label': 'Message body', class: 'composer-body' } },
    onUpdate: ({ editor: e }) => setHtml(e.getHTML())
  })

  const current = useCallback(
    (): Draft => ({
      id: draftId,
      accountId,
      to,
      cc,
      bcc,
      subject,
      html,
      inReplyTo: seed.inReplyTo,
      references: seed.references,
      attachments
    }),
    [draftId, accountId, to, cc, bcc, subject, html, attachments, seed.inReplyTo, seed.references]
  )

  const isEmpty =
    to.length + cc.length + bcc.length === 0 &&
    !subject.trim() &&
    attachments.length === 0 &&
    (editor?.getText().trim() ?? '') === (seed.html ? new DOMParser().parseFromString(seed.html, 'text/html').body.innerText.trim() : '')

  // Autosave locally a moment after the last change; an untouched compose window saves nothing.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (isEmpty) return
    const t = setTimeout(() => {
      void window.imc
        .invoke('compose:saveDraft', current())
        .then(({ id }) => {
          setDraftId(id)
          setSavedAt(Date.now())
          void qc.invalidateQueries({ queryKey: ['drafts'] })
        })
        .catch(() => {})
    }, 1500)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, to, cc, bcc, subject, html, attachments])

  const mediaKit = useMediaKit()
  const streamer = useStreamerFeatures()
  const attachKit = async () => {
    let kit = mediaKit.data ?? null
    if (!kit) {
      kit = await window.imc.invoke('mediaKit:choose')
      void qc.invalidateQueries({ queryKey: ['mediakit'] })
    }
    if (kit && !attachments.some((a) => a.path === kit!.path)) await attach([kit.path])
  }

  const attach = async (paths?: string[]) => {
    try {
      const files = await window.imc.invoke('compose:attach', { paths })
      setAttachments((a) => [...a, ...files])
      setError(null)
    } catch (e) {
      setError(errText(e))
    }
  }

  const [followUpDays, setFollowUpDays] = useState(0)
  const send = async (sendAt?: number) => {
    if (busy) return
    // Placeholders like {{rate}} that nothing filled in would go out as literal text.
    const left = placeholdersIn(`${subject} ${editor?.getText() ?? ''}`)
    if (
      left.length > 0 &&
      !(await askConfirm({
        title: 'Send with blanks?',
        message: `This message still has ${left.map((v) => '{{' + v + '}}').join(', ')} to fill in. They would go out as written.`,
        confirmLabel: 'Send anyway',
        cancelLabel: 'Keep editing'
      }))
    ) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      await window.imc.invoke('compose:send', { ...current(), sendAt, followUpDays: followUpDays || undefined })
      void qc.invalidateQueries({ queryKey: ['drafts'] })
      onQueued()
      onClose()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const discard = async () => {
    if (!isEmpty && !(await askConfirm({ title: 'Discard this message?', message: 'What you have written will be thrown away.', confirmLabel: 'Discard', cancelLabel: 'Keep editing', danger: true }))) return
    if (draftId) await window.imc.invoke('compose:discardDraft', { id: draftId })
    void qc.invalidateQueries({ queryKey: ['drafts'] })
    onClose()
  }

  const closeKeepingDraft = () => {
    // Autosave has already stored it; closing never loses work.
    onClose()
  }

  const setLink = async () => {
    if (!editor) return
    const prev = editor.getAttributes('link')['href'] as string | undefined
    const url = await askText({
      title: prev ? 'Edit link' : 'Add a link',
      message: prev ? 'Leave it empty to remove the link.' : undefined,
      label: 'Link address',
      initial: prev ?? 'https://',
      confirmLabel: 'Apply',
      allowEmpty: true
    })
    if (url === null) return
    if (url === '') editor.chain().focus().extendMarkRange('link').unsetLink().run()
    else editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
  }

  /** Drops a saved reply into the message, filling {{variables}} from who it is going to. */
  const applyTemplate = (t: Template) => {
    if (!editor) return
    const vars = {
      recipient: to[0],
      myName: account?.displayName || undefined,
      myEmail: account?.email,
      subject
    }
    const body = fillTemplate(t.html, vars, true)
    editor.chain().focus().insertContent(body.text).run()
    const subj = t.subject ? fillTemplate(t.subject, vars) : null
    if (subj && !subject.trim()) setSubject(subj.text)
    if (t.attachments.length > 0) {
      setAttachments((list) => [
        ...list,
        ...t.attachments.filter((a) => !list.some((x) => x.path === a.path))
      ])
    }
    const missing = [...new Set([...body.unresolved, ...(subj?.unresolved ?? [])])]
    setNote(
      missing.length > 0
        ? `Fill in ${missing.map((v) => '{{' + v + '}}').join(', ')} before sending.`
        : null
    )
  }

  const saveAsTemplate = async () => {
    const name = (await askText({ title: 'Save as template', label: 'Template name', initial: subject.trim() || 'New template', confirmLabel: 'Save template' }))?.trim()
    if (!name) return
    const existing = (await window.imc.invoke('templates:list')).find(
      (t) => t.name.toLowerCase() === name.toLowerCase()
    )
    if (existing && !(await askConfirm({ title: `Replace "${existing.name}"?`, message: 'A template with that name already exists. Its text and attachments will be replaced.', confirmLabel: 'Replace' }))) return
    try {
      await window.imc.invoke('templates:save', {
        id: existing?.id,
        name,
        subject,
        html,
        attachments
      })
      await qc.invalidateQueries({ queryKey: ['templates'] })
      setNote(`Saved the template "${name}".`)
    } catch (e) {
      setError(errText(e))
    }
  }

  const invalid = [...to, ...cc, ...bcc].filter((r) => !isValidRecipient(r))

  return (
    <section
      aria-label="New message"
      className="relative flex min-w-0 flex-1 flex-col bg-sheet"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          void send()
        } else if (e.key === 'Escape' && !e.defaultPrevented) closeKeepingDraft()
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        const paths = [...e.dataTransfer.files].map((f) => window.imc.getFilePath(f)).filter(Boolean)
        if (paths.length) void attach(paths)
      }}
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
        <h2 className="min-w-0 flex-1 truncate text-md font-semibold">
          {subject.trim() || 'New message'}
        </h2>
        {savedAt && (
          <span className="num text-sm text-ink-3">
            Draft saved {new Date(savedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
          </span>
        )}
        <button className={btn} aria-label="Close and keep draft" title="Close (Esc). The draft is kept." onClick={closeKeepingDraft}>
          <X size={16} strokeWidth={1.75} aria-hidden />
        </button>
      </header>

      <div className="flex items-center gap-3 border-b border-line px-4 py-1.5">
        <label htmlFor="from" className="w-10 shrink-0 text-sm text-ink-3">
          From
        </label>
        <span
          className="tape shrink-0"
          style={{ background: tapeColor(account?.color) }}
          aria-hidden
        />
        <select
          id="from"
          value={accountId}
          onChange={(e) => {
            setAccountId(e.target.value)
            setSignature(accounts.find((a) => a.id === e.target.value)?.signature ?? '')
          }}
          className="h-7 min-w-0 flex-1 rounded-sm bg-transparent text-ink"
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id} className="bg-raised">
              {a.displayName ? `${a.displayName} <${a.email}>` : a.email}
            </option>
          ))}
        </select>
        {!showCc && (
          <button className="text-sm text-accent underline underline-offset-2 hover:text-accent-hover" onClick={() => setShowCc(true)}>
            Cc / Bcc
          </button>
        )}
      </div>

      <RecipientInput label="To" value={to} onChange={setTo} autoFocus={seed.to.length === 0} />
      {showCc && (
        <>
          <RecipientInput label="Cc" value={cc} onChange={setCc} />
          <RecipientInput label="Bcc" value={bcc} onChange={setBcc} />
        </>
      )}
      <div className="flex items-center gap-3 border-b border-line px-4 py-1.5">
        <label htmlFor="subject" className="w-10 shrink-0 text-sm text-ink-3">
          Subject
        </label>
        <input
          id="subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          autoFocus={seed.to.length > 0 && !seed.subject}
          className="h-7 min-w-0 flex-1 bg-transparent text-ink outline-none focus-visible:outline-none"
        />
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-line px-3 py-1" role="toolbar" aria-label="Formatting">
        <ToolButton label="Bold" Icon={Bold} active={editor?.isActive('bold')} onClick={() => editor?.chain().focus().toggleBold().run()} />
        <ToolButton label="Italic" Icon={Italic} active={editor?.isActive('italic')} onClick={() => editor?.chain().focus().toggleItalic().run()} />
        <ToolButton label="Underline" Icon={UnderlineIcon} active={editor?.isActive('underline')} onClick={() => editor?.chain().focus().toggleUnderline().run()} />
        <ToolButton label="Bulleted list" Icon={List} active={editor?.isActive('bulletList')} onClick={() => editor?.chain().focus().toggleBulletList().run()} />
        <ToolButton label="Numbered list" Icon={ListOrdered} active={editor?.isActive('orderedList')} onClick={() => editor?.chain().focus().toggleOrderedList().run()} />
        <ToolButton label="Quote" Icon={Quote} active={editor?.isActive('blockquote')} onClick={() => editor?.chain().focus().toggleBlockquote().run()} />
        <ToolButton label="Link" Icon={Link2} active={editor?.isActive("link")} onClick={() => void setLink()} />
        <span className="mx-1 h-5 w-px bg-line" aria-hidden />
        <ToolButton label="Undo" Icon={Undo2} disabled={!editor?.can().undo()} onClick={() => editor?.chain().focus().undo().run()} />
        <ToolButton label="Redo" Icon={Redo2} disabled={!editor?.can().redo()} onClick={() => editor?.chain().focus().redo().run()} />
        <span className="mx-1 h-5 w-px bg-line" aria-hidden />
        <ToolButton label="Attach files" Icon={Paperclip} onClick={() => void attach()} />
        {streamer && (
          <ToolButton
            label={mediaKit.data ? `Attach media kit (${mediaKit.data.filename})` : 'Choose and attach your media kit'}
            Icon={FileText}
            onClick={() => void attachKit()}
          />
        )}
        <TemplatesMenu onPick={applyTemplate} onSaveAs={() => void saveAsTemplate()} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <EditorContent editor={editor} />
      </div>

      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-line px-4 py-2" aria-label="Attachments">
          {attachments.map((a) => (
            <span key={a.id} className="flex h-8 max-w-64 items-center gap-2 rounded-md border border-line-strong pr-1 pl-2.5 text-sm">
              <Paperclip size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
              <span className="truncate">{a.filename}</span>
              <span className="num shrink-0 text-ink-3">{formatBytes(a.size)}</span>
              <button
                type="button"
                aria-label={`Remove ${a.filename}`}
                className="grid size-6 place-items-center rounded-sm text-ink-3 hover:bg-hover hover:text-ink"
                onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}
              >
                <X size={12} strokeWidth={1.75} aria-hidden />
              </button>
            </span>
          ))}
        </div>
      )}

      {sigOpen && (
        <div className="space-y-2 border-t border-line px-4 py-3">
          <label htmlFor="sig" className="block text-sm text-ink-2">
            Signature for {account?.email} (added to new messages)
          </label>
          <textarea
            id="sig"
            value={signature}
            onChange={(e) => setSignature(e.target.value)}
            rows={3}
            className="w-full resize-none rounded-md border border-line-strong bg-sheet px-3 py-2 text-ink"
          />
          <div className="flex gap-2">
            <button
              className="h-8 rounded-md border border-line-strong px-3 text-sm hover:bg-hover"
              onClick={() => {
                void window.imc
                  .invoke('accounts:setSignature', { id: accountId, signature })
                  .then(() => qc.invalidateQueries({ queryKey: ['accounts'] }))
                  .then(() => setSigOpen(false))
              }}
            >
              Save signature
            </button>
            <button className="h-8 rounded-md px-3 text-sm text-ink-2 hover:bg-hover" onClick={() => setSigOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {note && (
        <p role="status" className="border-t border-line px-4 py-2 text-sm text-ink-2">
          {note}
        </p>
      )}

      {(error || invalid.length > 0) && (
        <p role="alert" className="flex items-start gap-2 border-t border-line px-4 py-2 text-alert">
          <TriangleAlert size={16} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden />
          {error ?? `Fix or remove: ${invalid.join(', ')}`}
        </p>
      )}

      <footer className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-3">
        <span className="flex">
          <button
            type="button"
            onClick={() => void send()}
            disabled={busy || invalid.length > 0}
            className="h-9 rounded-l-md bg-accent px-5 font-medium text-on-accent transition-colors duration-(--dur-fast) hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? 'Queuing' : 'Send'}
          </button>
          <ScheduleMenu disabled={busy || invalid.length > 0} onSchedule={(at) => void send(at)} />
        </span>
        <label className="flex items-center gap-1.5 text-sm text-ink-2">
          <span className="sr-only">Remind me if nobody replies</span>
          <select
            aria-label="Remind me if nobody replies"
            value={followUpDays}
            onChange={(e) => setFollowUpDays(Number(e.target.value))}
            className="h-9 rounded-md border border-line-strong bg-sheet px-2 text-ink"
          >
            <option value={0}>No follow-up reminder</option>
            <option value={2}>Remind if no reply in 2 days</option>
            <option value={3}>Remind if no reply in 3 days</option>
            <option value={7}>Remind if no reply in 1 week</option>
            <option value={14}>Remind if no reply in 2 weeks</option>
          </select>
        </label>
        <span className="text-sm text-ink-3">Ctrl+Enter</span>
        <button
          type="button"
          onClick={() => setSigOpen((v) => !v)}
          className="ml-auto h-9 rounded-md px-3 text-sm text-ink-2 hover:bg-hover hover:text-ink"
        >
          Signature
        </button>
        <button
          type="button"
          onClick={() => void discard()}
          className="h-9 rounded-md px-3 text-sm text-ink-2 hover:bg-hover hover:text-ink"
        >
          Discard
        </button>
      </footer>

      {dragging && (
        <div className="pointer-events-none absolute inset-2 grid place-items-center border-2 border-dashed border-accent bg-sheet/90 text-md font-medium">
          Drop files to attach
        </div>
      )}
    </section>
  )
}
