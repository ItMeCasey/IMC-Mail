import { useEffect, useRef, useState } from 'react'
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import type { Draft, ReplyMode } from '@imc/core'
import AddAccount from './AddAccount'
import Composer, { signatureHtml } from './Composer'
import DraftsDialog from './DraftsDialog'
import OutboxToast from './OutboxToast'
import MessageList from './MessageList'
import ReadingPane from './ReadingPane'
import Sidebar from './Sidebar'
import {
  useAccounts,
  useDrafts,
  useFolders,
  useMessages,
  useSyncInvalidation,
  useThread,
  type Selection
} from './hooks'

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: Infinity, refetchOnWindowFocus: false } }
})

function Shell() {
  const qc = useQueryClient()
  const accounts = useAccounts()
  const folders = useFolders()
  const [selection, setSelection] = useState<Selection>({})
  const [openId, setOpenId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [composer, setComposer] = useState<{ key: number; seed: Draft } | null>(null)
  const [draftsOpen, setDraftsOpen] = useState(false)
  const [composeError, setComposeError] = useState<string | null>(null)
  const drafts = useDrafts()
  const messages = useMessages(selection)
  const thread = useThread(openId)
  useSyncInvalidation()

  const folder = folders.data?.find((f) => f.id === selection.folderId)
  const account = accounts.data?.find((a) => a.id === selection.accountId)
  const title = folder
    ? `${account?.displayName || account?.email || ''} · ${folder.name}`
    : 'All inboxes'

  // Opening a message marks it read, once per message.
  const markedRead = useRef(new Set<string>())
  useEffect(() => {
    const sel = thread.data?.messages.find((m) => m.id === thread.data?.selectedId)
    if (!sel?.unread || markedRead.current.has(sel.id)) return
    markedRead.current.add(sel.id)
    void window.imc
      .invoke('messages:setFlags', { id: sel.id, seen: true })
      .then(() => qc.invalidateQueries())
      .catch(() => markedRead.current.delete(sel.id)) // offline: try again on the next open
  }, [thread.data, qc])

  // Escape closes the reading pane, unless a dialog is up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && openId && !adding && !composer && !draftsOpen) setOpenId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openId, adding, composer, draftsOpen])

  const openComposer = (seed: Draft) => setComposer({ key: Date.now(), seed })

  const sigFor = (accountId: string) =>
    signatureHtml(accounts.data?.find((a) => a.id === accountId)?.signature ?? '')

  const newMessage = () => {
    const first = accounts.data?.find((a) => a.id === selection.accountId) ?? accounts.data?.[0]
    if (!first) return
    openComposer({
      accountId: first.id,
      to: [],
      cc: [],
      bcc: [],
      subject: '',
      html: sigFor(first.id),
      attachments: []
    })
  }

  const reply = async (messageId: string, mode: ReplyMode) => {
    setComposeError(null)
    try {
      const ctx = await window.imc.invoke('compose:replyContext', { messageId, mode })
      openComposer({
        accountId: ctx.accountId,
        to: ctx.to,
        cc: ctx.cc,
        bcc: [],
        subject: ctx.subject,
        html: sigFor(ctx.accountId) + ctx.html,
        inReplyTo: ctx.inReplyTo,
        references: ctx.references,
        attachments: []
      })
    } catch (e) {
      setComposeError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
    }
  }

  const openDraft = async (id: string) => {
    const d = await window.imc.invoke('compose:loadDraft', { id })
    if (d) openComposer(d)
  }

  const select = (s: Selection) => {
    setSelection(s)
    setOpenId(null)
  }

  const remove = async (id: string) => {
    if (selection.accountId === id) select({})
    await window.imc.invoke('accounts:remove', { id })
    await qc.invalidateQueries()
  }

  return (
    <div className="flex h-full">
      <Sidebar
        accounts={accounts.data ?? []}
        folders={folders.data ?? []}
        selection={selection}
        onSelect={select}
        onAdd={() => setAdding(true)}
        onCompose={newMessage}
        onDrafts={() => setDraftsOpen(true)}
        draftCount={drafts.data?.length ?? 0}
        onRemove={remove}
        onResync={(id) => void window.imc.invoke('accounts:resync', { id })}
      />
      <MessageList
        title={title}
        messages={messages.data ?? []}
        accounts={accounts.data ?? []}
        loading={messages.isPending || accounts.isPending}
        selectedId={openId}
        forceCompact={composer !== null}
        onSelect={(id) => {
          setComposer(null)
          setOpenId(id)
        }}
        onAdd={() => setAdding(true)}
      />
      {composer && accounts.data && (
        <Composer
          key={composer.key}
          seed={composer.seed}
          accounts={accounts.data}
          onClose={() => setComposer(null)}
          onQueued={() => void qc.invalidateQueries({ queryKey: ['outbox'] })}
        />
      )}
      {openId && !composer && (
        <ReadingPane
          key={openId}
          thread={thread.data}
          loading={thread.isPending}
          error={thread.error}
          onClose={() => setOpenId(null)}
          onReply={(id, mode) => void reply(id, mode)}
        />
      )}
      {composeError && (
        <p role="alert" className="fixed top-4 right-4 z-30 max-w-sm rounded-md border border-alert bg-raised px-3 py-2 text-alert">
          {composeError}{' '}
          <button className="underline" onClick={() => setComposeError(null)}>
            Dismiss
          </button>
        </p>
      )}
      {draftsOpen && (
        <DraftsDialog
          accounts={accounts.data ?? []}
          onClose={() => setDraftsOpen(false)}
          onOpen={(id) => void openDraft(id)}
        />
      )}
      <OutboxToast onEdit={openComposer} />
      {adding && <AddAccount onClose={() => setAdding(false)} />}
    </div>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Shell />
    </QueryClientProvider>
  )
}
