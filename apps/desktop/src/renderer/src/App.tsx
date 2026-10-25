import { useEffect, useRef, useState } from 'react'
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { CATEGORY_LABELS, type Draft, type MessageAction, type ReplyMode, type UndoMove } from '@imc/core'
import Agenda from './Agenda'
import DealsBoard from './DealsBoard'
import ScheduledDialog from './ScheduledDialog'
import NotificationSettingsDialog from './NotificationSettings'
import AddAccount from './AddAccount'
import Composer, { signatureHtml } from './Composer'
import DraftsDialog from './DraftsDialog'
import OutboxToast from './OutboxToast'
import UndoToast from './UndoToast'
import LoadOlder from './LoadOlder'
import MessageList from './MessageList'
import ReadingPane from './ReadingPane'
import Sidebar from './Sidebar'
import { HiddenNotice, useStreamSafe } from './streamsafe'
import {
  useAccounts,
  useDeals,
  useDrafts,
  useOutbox,
  useLabels,
  useViewCounts,
  useFolders,
  useMessages,
  useSearch,
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
  const [board, setBoard] = useState(false)
  const [calendar, setCalendar] = useState(false)
  const [notifOpen, setNotifOpen] = useState(false)
  const [undo, setUndo] = useState<UndoMove | null>(null)
  const [scheduledOpen, setScheduledOpen] = useState(false)
  const outbox = useOutbox()
  const [focusDeal, setFocusDeal] = useState<string | null>(null)
  const counts = useViewCounts()
  const labels = useLabels()
  const deals = useDeals()
  const stream = useStreamSafe()
  const hide = stream.active
  const drafts = useDrafts()
  const messages = useMessages(selection)
  const thread = useThread(openId)

  // Search: the box updates at once, the query runs shortly after you stop typing.
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 200)
    return () => clearTimeout(t)
  }, [query])
  const searching = debounced.length > 0
  const search = useSearch(debounced)
  const listData = searching ? search.data : messages.data
  const listLoading = searching
    ? search.isPending
    : messages.isPending || accounts.isPending
  const listKey = searching ? ['search', debounced] : ['messages', selection]
  useSyncInvalidation()

  const folder = folders.data?.find((f) => f.id === selection.folderId)
  const account = accounts.data?.find((a) => a.id === selection.accountId)
  const viewTitle = selection.view === 'needsReply' ? 'Needs reply' : selection.view === 'waiting' ? 'Waiting on reply' : selection.view === 'suspicious' ? 'Suspicious mail' : selection.view === 'snoozed' ? 'Snoozed' : selection.view === 'followUp' ? 'Follow-ups' : selection.labelId ? `Label: ${labels.data?.find((l) => l.id === selection.labelId)?.name ?? ''}` : selection.category ? CATEGORY_LABELS[selection.category] : null
  const title = searching
    ? 'Search results'
    : viewTitle
      ? viewTitle
      : folder
    ? hide
      ? folder.name
      : `${account?.displayName || account?.email || ''} · ${folder.name}`
    : 'All inboxes'

  const blocked = () => {
    setComposeError('Stream-safe mode is on. Press Ctrl+Shift+L to turn it off first.')
  }

  // Clicking a desktop notification opens that message.
  useEffect(
    () =>
      window.imc.on('notification:open', ({ messageId }) => {
        setBoard(false)
        setCalendar(false)
        setComposer(null)
        setQuery('')
        setSelection({})
        setOpenId(messageId)
      }),
    []
  )

  // Close anything that shows private content the moment the mode turns on.
  useEffect(() => {
    if (hide) {
      setAdding(false)
      setDraftsOpen(false)
      setScheduledOpen(false)
    }
  }, [hide])

  // Opening a message marks it read, once per message.
  const markedRead = useRef(new Set<string>())
  useEffect(() => {
    // A message you could not see has not been read.
    if (hide) return
    const sel = thread.data?.messages.find((m) => m.id === thread.data?.selectedId)
    if (!sel?.unread || markedRead.current.has(sel.id)) return
    markedRead.current.add(sel.id)
    void window.imc
      .invoke('messages:setFlags', { id: sel.id, seen: true })
      .then(() => qc.invalidateQueries())
      .catch(() => markedRead.current.delete(sel.id)) // offline: try again on the next open
  }, [thread.data, qc, hide])

  // "/" or Ctrl+K jumps to the search box from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const typing = !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)
      if ((e.key === '/' && !typing && !e.ctrlKey && !e.metaKey) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
        const box = document.getElementById('search-input') as HTMLInputElement | null
        if (box) {
          e.preventDefault()
          box.focus()
          box.select()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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
    if (hide) return blocked()
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
    if (hide) return blocked()
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
    if (hide) return blocked()
    const d = await window.imc.invoke('compose:loadDraft', { id })
    if (d) openComposer(d)
  }

  /** Archive, trash, junk, move, or erase the open message, then move on to the next one. */
  const act = async (action: MessageAction, folderId?: string) => {
    if (!openId || hide) return
    if (
      action === 'deleteForever' &&
      !confirm('Delete this message permanently? This cannot be undone.')
    ) {
      return
    }
    const list = listData ?? []
    const i = list.findIndex((m) => m.id === openId)
    const next = list[i + 1] ?? list[i - 1] ?? null
    const id = openId
    // Optimistic: the row leaves the list now; a refusal puts everything back.
    qc.setQueryData<typeof list>(listKey, (old) => old?.filter((m) => m.id !== id))
    setOpenId(next?.id ?? null)
    try {
      const r = await window.imc.invoke('messages:act', { id, action, folderId })
      setUndo(r.undo)
    } catch (e) {
      setOpenId(id)
      setComposeError(
        (e instanceof Error ? e.message : String(e)).replace(
          /^Error invoking remote method '[^']+': (Error: )?/,
          ''
        )
      )
    } finally {
      await qc.invalidateQueries()
    }
  }

  /** Hides the open message until later (or brings it back), then moves to the next one. */
  const snooze = async (until: number | null) => {
    if (!openId || hide) return
    const list = listData ?? []
    const i = list.findIndex((m) => m.id === openId)
    const next = list[i + 1] ?? list[i - 1] ?? null
    const id = openId
    const leaving = until !== null && selection.view !== 'snoozed'
    if (leaving) {
      qc.setQueryData<typeof list>(listKey, (old) => old?.filter((m) => m.id !== id))
      setOpenId(next?.id ?? null)
    }
    try {
      await window.imc.invoke('messages:snooze', { id, until })
    } catch (e) {
      if (leaving) setOpenId(id)
      setComposeError(
        (e instanceof Error ? e.message : String(e)).replace(
          /^Error invoking remote method '[^']+': (Error: )?/,
          ''
        )
      )
    } finally {
      await qc.invalidateQueries()
    }
  }

  /** Sets or clears "remind me if nobody replies" on the open message. */
  const followUp = async (at: number | null) => {
    if (!openId || hide) return
    try {
      await window.imc.invoke('messages:followUp', { id: openId, at })
    } catch (e) {
      setComposeError(
        (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      )
    } finally {
      await qc.invalidateQueries()
    }
  }

  // Keyboard: e archive, # delete, ! junk, r reply. Never while typing or while hidden.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!openId || composer || adding || draftsOpen || hide) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return
      const here = folders.data?.find((f) => f.id === listData?.find((m) => m.id === openId)?.folderId)
      const permanent = here?.role === 'trash' || here?.role === 'junk'
      if (e.key === 'e') void act('archive')
      else if (e.key === '#' || e.key === 'Delete') void act(permanent ? 'deleteForever' : 'trash')
      else if (e.key === '!') void act('junk')
      else if (e.key === 'r') void reply(openId, 'reply')
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId, composer, adding, draftsOpen, hide, listData, folders.data, selection, debounced])

  const select = (s: Selection) => {
    setQuery('')
    setBoard(false)
    setCalendar(false)
    setSelection(s)
    setOpenId(null)
  }

  /** Starts a sponsorship deal from the open email and jumps to the board to fill it in. */
  const trackDeal = async (messageId: string) => {
    if (hide) return blocked()
    try {
      const d = await window.imc.invoke('deals:create', { messageId })
      await qc.invalidateQueries({ queryKey: ['deals'] })
      setFocusDeal(d.id)
      setOpenId(null)
      setBoard(true)
    } catch (e) {
      setComposeError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
    }
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
        onAdd={() => (hide ? blocked() : setAdding(true))}
        onCompose={newMessage}
        onDrafts={() => (hide ? blocked() : setDraftsOpen(true))}
        streamSafe={stream}
        counts={counts.data}
        labels={labels.data ?? []}
        dealCount={(deals.data ?? []).filter((d) => ['lead', 'negotiating', 'contracted'].includes(d.stage)).length}
        boardActive={board}
        calendarActive={calendar}
        onCalendar={() => {
          setOpenId(null)
          setComposer(null)
          setQuery('')
          setBoard(false)
          setCalendar(true)
        }}
        onNotifications={() => setNotifOpen(true)}
        onBoard={() => {
          setOpenId(null)
          setComposer(null)
          setQuery('')
          setCalendar(false)
          setBoard(true)
        }}
        draftCount={drafts.data?.length ?? 0}
        scheduledCount={(outbox.data ?? []).filter((i) => i.scheduled && i.state === 'queued').length}
        onScheduled={() => (hide ? blocked() : setScheduledOpen(true))}
        onRemove={remove}
        onResync={(id) => void window.imc.invoke('accounts:resync', { id })}
      />
      {board &&
        (hide ? (
          <HiddenNotice what="The sponsorship board" />
        ) : (
          <DealsBoard
            deals={deals.data ?? []}
            hide={hide}
            focusId={focusDeal}
            onFocused={() => setFocusDeal(null)}
            onOpenMessage={(id) => {
              setBoard(false)
              setSelection({})
              setOpenId(id)
            }}
          />
        ))}
      {calendar &&
        (hide ? (
          <HiddenNotice what="The calendar" />
        ) : (
          <Agenda
            accounts={accounts.data ?? []}
            hide={hide}
            onOpenMessage={(id) => {
              setCalendar(false)
              setSelection({})
              setOpenId(id)
            }}
          />
        ))}
      {!board && !calendar && (
      <MessageList
        title={title}
        messages={listData ?? []}
        query={query}
        onQuery={setQuery}
        searching={searching}
        accounts={accounts.data ?? []}
        loading={listLoading}
        hide={hide}
        footer={!searching && selection.folderId && !hide ? <LoadOlder key={selection.folderId} folderId={selection.folderId} onError={setComposeError} /> : null}
        selectedId={openId}
        forceCompact={composer !== null}
        onSelect={(id) => {
          setComposer(null)
          setOpenId(id)
        }}
        onAdd={() => (hide ? blocked() : setAdding(true))}
      />
      )}
      {!board && !calendar && composer && hide && <HiddenNotice what="The message you are writing" />}
      {!board && !calendar && composer && accounts.data && (
        <div className={hide ? 'hidden' : 'contents'}>
        <Composer
          key={composer.key}
          seed={composer.seed}
          accounts={accounts.data}
          onClose={() => setComposer(null)}
          onQueued={() => void qc.invalidateQueries({ queryKey: ['outbox'] })}
        />
        </div>
      )}
      {!board && !calendar && openId && !composer && hide && <HiddenNotice what="This message" />}
      {!board && !calendar && openId && !composer && !hide && (
        <ReadingPane
          key={openId}
          thread={thread.data}
          loading={thread.isPending}
          error={thread.error}
          onClose={() => setOpenId(null)}
          onReply={(id, mode) => void reply(id, mode)}
          onAct={(action, folderId) => void act(action, folderId)}
          folders={folders.data ?? []}
          onTrackDeal={(id) => void trackDeal(id)}
          onSnooze={(until) => void snooze(until)}
          onFollowUp={(at) => void followUp(at)}
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
      <OutboxToast onEdit={openComposer} hide={hide} />
      {undo && !hide && (
        <UndoToast
          key={undo.messageId + undo.from}
          undo={undo}
          onDone={() => setUndo(null)}
          onError={setComposeError}
        />
      )}
      {scheduledOpen && (
        <ScheduledDialog onEdit={openComposer} onClose={() => setScheduledOpen(false)} />
      )}
      {notifOpen && <NotificationSettingsDialog onClose={() => setNotifOpen(false)} />}
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
