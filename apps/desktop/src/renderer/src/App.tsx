import { useEffect, useRef, useState } from 'react'
import { QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { CATEGORY_LABELS, type Draft, type Folder, type MessageAction, type ReplyMode, type UndoMove } from '@imc/core'
import Agenda from './Agenda'
import DealsBoard from './DealsBoard'
import ScheduledDialog from './ScheduledDialog'
import CommandPalette, { type Command } from './CommandPalette'
import { askConfirm, DialogHost } from './dialogs'
import WindowFrame from './WindowFrame'
import type { BulkAction } from './BulkBar'
import RulesDialog from './RulesDialog'
import FolderNameDialog from './FolderNameDialog'
import ReportDialog from './ReportDialog'
import { queryClient } from './queryClient'
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
  useSavedSearches,
  useViewCounts,
  useFolders,
  useMessages,
  useSearch,
  useStreamerFeatures,
  useSyncInvalidation,
  useThread,
  type Selection
} from './hooks'

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
  const [rulesOpen, setRulesOpen] = useState(false)
  const [newFolder, setNewFolder] = useState<{ accountId: string; parent: Folder | null } | null>(null)
  const [renaming, setRenaming] = useState<Folder | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const anchor = useRef<string | null>(null)
  const [reporting, setReporting] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [undo, setUndo] = useState<UndoMove | null>(null)
  const [scheduledOpen, setScheduledOpen] = useState(false)
  const outbox = useOutbox()
  const [focusDeal, setFocusDeal] = useState<string | null>(null)
  const counts = useViewCounts()
  const labels = useLabels()
  const searches = useSavedSearches()
  const deals = useDeals()
  const stream = useStreamSafe()
  const hide = stream.active
  const streamer = useStreamerFeatures()
  // Turning streamer features off while on the board or a mail-kind list moves back to the inbox view.
  useEffect(() => {
    if (streamer) return
    setBoard(false)
    setSelection((s) => (s.category ? { ...s, category: undefined } : s))
  }, [streamer])
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

  // If the app logged an error since it last asked, offer to report it (once; "Not now" stops the asking).
  useEffect(() => {
    let cancelled = false
    void window.imc.invoke('report:summary').then(async (r) => {
      if (cancelled || !r.hasNew) return
      const yes = await askConfirm({
        title: 'IMC-Mail ran into a problem',
        message: 'The app logged an error. You can report it on GitHub; you will see everything that would be included before anything is sent.',
        confirmLabel: 'Review report',
        cancelLabel: 'Not now'
      })
      if (yes) setReporting(true)
      else void window.imc.invoke('report:dismiss')
    })
    return () => {
      cancelled = true
    }
  }, [])

  // The gear in the title bar (outside this component) asks for the settings panel.
  useEffect(() => {
    const open = () => void window.imc.invoke('settings:open')
    window.addEventListener('imc:open-settings', open)
    return () => window.removeEventListener('imc:open-settings', open)
  }, [])

  // The settings window asks for dialogs that live here. Kept in a ref so the subscription is made once.
  const onSettingsAction = useRef<(a: { kind: string; accountId?: string | undefined }) => void>(() => {})
  onSettingsAction.current = ({ kind, accountId }) => {
    if (kind === 'notifications') setNotifOpen(true)
    else if (kind === 'report') setReporting(true)
    else if (kind === 'addAccount') hide ? blocked() : setAdding(true)
    else if (kind === 'rules') hide ? blocked() : setRulesOpen(true)
    else if (kind === 'removeAccount') {
      const a = (accounts.data ?? []).find((x) => x.id === accountId)
      if (!a) return
      void askConfirm({
        title: 'Remove this account?',
        message: `${a.email} and its cached mail are removed from this computer. Nothing is deleted on the mail server.`,
        confirmLabel: 'Remove account',
        danger: true
      }).then((ok) => (ok ? remove(a.id) : undefined))
    }
  }
  useEffect(() => window.imc.on('settings:action', (a) => onSettingsAction.current(a)), [])

  // Settings are changed in a window of their own: look again at everything when this one is used.
  useEffect(() => {
    const again = () => void qc.invalidateQueries()
    window.addEventListener('focus', again)
    return () => window.removeEventListener('focus', again)
  }, [qc])

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

  // "/" jumps to the search box from anywhere; Ctrl+K opens the command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const typing = !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
        return
      }
      if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey) {
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
      if (e.key === 'Escape' && checked.size > 0) setChecked(new Set())
      else if (e.key === 'Escape' && openId && !adding && !composer && !draftsOpen) setOpenId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openId, adding, composer, draftsOpen, checked])

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
      !(await askConfirm({ title: 'Delete this message?', message: 'It will be deleted for good. This cannot be undone.', confirmLabel: 'Delete forever', danger: true }))
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

  /** Marks every message in an account's Inbox read or unread, after asking. */
  const markAll = async (accountId: string, seen: boolean) => {
    if (hide) return blocked()
    const a = accounts.data?.find((x) => x.id === accountId)
    const who = a?.displayName || a?.email || 'this account'
    if (!(await askConfirm({ title: `Mark everything ${seen ? 'read' : 'unread'}?`, message: `Every message in the Inbox of ${who} will be marked ${seen ? 'read' : 'unread'}, on the mail server too.`, confirmLabel: seen ? 'Mark all read' : 'Mark all unread' }))) return
    try {
      await window.imc.invoke('accounts:markAll', { id: accountId, seen })
    } catch (e) {
      setComposeError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      await qc.invalidateQueries()
    }
  }

  /** Deletes a folder from the server after spelling out what that does. */
  const deleteFolder = async (f: Folder) => {
    if (hide) return blocked()
    const what =
      f.total > 0
        ? `It holds ${f.total} cached ${f.total === 1 ? 'message' : 'messages'} (the server may hold more), and they will be deleted too.`
        : 'Any messages in it will be deleted too.'
    if (!(await askConfirm({ title: `Delete the folder "${f.name}"?`, message: `${what} This cannot be undone.`, confirmLabel: 'Delete folder', danger: true }))) return
    try {
      await window.imc.invoke('folders:delete', { folderId: f.id })
      if (selection.folderId === f.id) select({})
    } catch (e) {
      setComposeError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      await qc.invalidateQueries()
    }
  }

  /** A click on a list row: plain opens it, Ctrl ticks it, Shift ticks everything from the last click. */
  const clickRow = (id: string, keys: { ctrl: boolean; shift: boolean }) => {
    const list = listData ?? []
    if (keys.shift && anchor.current) {
      const a = list.findIndex((m) => m.id === anchor.current)
      const b = list.findIndex((m) => m.id === id)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        setChecked(new Set(list.slice(lo, hi + 1).map((m) => m.id)))
        return
      }
    }
    if (keys.ctrl) {
      setChecked((c) => {
        const next = new Set(c)
        // The open message counts as ticked when you start ticking others.
        if (next.size === 0 && openId && openId !== id) next.add(openId)
        if (!next.delete(id)) next.add(id)
        return next
      })
      anchor.current = id
      return
    }
    anchor.current = id
    setChecked(new Set())
    setComposer(null)
    setOpenId(id)
  }

  /** Archive, trash, junk or mark every ticked message. Failures are counted, not fatal. */
  const bulk = async (action: BulkAction) => {
    if (hide || checked.size === 0) return
    const ids = [...checked]
    setChecked(new Set())
    const list = listData ?? []
    const leaving = action === 'archive' || action === 'trash' || action === 'junk'
    if (leaving) {
      qc.setQueryData<typeof list>(listKey, (old) => old?.filter((m) => !ids.includes(m.id)))
      if (openId && ids.includes(openId)) setOpenId(null)
    }
    let failed = 0
    let why = ''
    for (const id of ids) {
      try {
        if (leaving) await window.imc.invoke('messages:act', { id, action })
        else await window.imc.invoke('messages:setFlags', { id, seen: action === 'read' })
      } catch (e) {
        failed++
        why = (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      }
    }
    if (failed > 0) setComposeError(`${failed} of ${ids.length} could not be changed: ${why}`)
    await qc.invalidateQueries()
  }

  /** Moves messages dropped on a folder; only those from that folder's own account can go. */
  const moveMany = async (idsText: string, folderId: string) => {
    const ids = idsText.split(',').filter(Boolean)
    if (ids.length <= 1) return void moveMessage(ids[0] ?? '', folderId)
    if (hide) return
    const target = folders.data?.find((f) => f.id === folderId)
    const list = listData ?? []
    const ok = ids.filter((id) => list.find((m) => m.id === id)?.accountId === target?.accountId)
    setChecked(new Set())
    qc.setQueryData<typeof list>(listKey, (old) => old?.filter((m) => !ok.includes(m.id)))
    if (openId && ok.includes(openId)) setOpenId(null)
    let failed = ids.length - ok.length
    let why = failed > 0 ? 'messages from other accounts stay where they are' : ''
    for (const id of ok) {
      try {
        await window.imc.invoke('messages:act', { id, action: 'move', folderId })
      } catch (e) {
        failed++
        why = (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      }
    }
    if (failed > 0) setComposeError(`${failed} of ${ids.length} not moved: ${why}`)
    await qc.invalidateQueries()
  }

  /** Moves a message dropped on a folder, with the same undo as the toolbar buttons. */
  const moveMessage = async (id: string, folderId: string) => {
    if (hide) return
    const list = listData ?? []
    const i = list.findIndex((m) => m.id === id)
    const next = id === openId ? (list[i + 1] ?? list[i - 1] ?? null) : null
    qc.setQueryData<typeof list>(listKey, (old) => old?.filter((m) => m.id !== id))
    if (id === openId) setOpenId(next?.id ?? null)
    try {
      const r = await window.imc.invoke('messages:act', { id, action: 'move', folderId })
      setUndo(r.undo)
    } catch (e) {
      if (id === openId) setOpenId(id)
      setComposeError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
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

  // With messages ticked: e archive, # delete, ! junk, Shift+I mark read, Shift+U mark unread.
  // Ctrl+A ticks every message in the list. Never while typing or while stream-safe mode hides things.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (composer || adding || draftsOpen || hide || calendar || board) return
      const t = e.target as HTMLElement | null
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return
      if (document.querySelector('dialog[open]')) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && (listData?.length ?? 0) > 0) {
        e.preventDefault()
        setChecked(new Set((listData ?? []).map((m) => m.id)))
        return
      }
      if (checked.size === 0 || e.ctrlKey || e.metaKey || e.altKey) return
      const k = e.key
      const action: BulkAction | null =
        k === 'e' ? 'archive' : k === '#' || k === 'Delete' ? 'trash' : k === '!' ? 'junk' : k === 'I' ? 'read' : k === 'U' ? 'unread' : null
      if (!action) return
      e.preventDefault()
      void bulk(action)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checked, listData, composer, adding, draftsOpen, hide, calendar, board])

  // Keyboard: e archive, # delete, ! junk, r reply. Never while typing or while hidden.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ticked messages have their own handler above.
      if (!openId || composer || adding || draftsOpen || hide || checked.size > 0) return
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
  }, [openId, composer, adding, draftsOpen, hide, listData, folders.data, selection, debounced, checked])

  const openBoard = () => {
    setOpenId(null)
    setComposer(null)
    setQuery('')
    setCalendar(false)
    setBoard(true)
  }
  const openCalendar = () => {
    setOpenId(null)
    setComposer(null)
    setQuery('')
    setBoard(false)
    setCalendar(true)
  }

  const select = (s: Selection) => {
    setChecked(new Set())
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

  /** What the palette offers. Names of accounts, folders, labels and searches stay out while stream-safe mode is on. */
  const STREAMER_COMMANDS = ['kit', 'ss', 'g-board']
  const commands: Command[] = [
    { id: 'compose', label: 'Compose a new message', group: 'Action', run: newMessage },
    { id: 'settings', label: 'Open settings', group: 'Action', run: () => void window.imc.invoke('settings:open') },
    { id: 'add', label: 'Add an account', group: 'Action', run: () => (hide ? blocked() : setAdding(true)) },
    { id: 'rules', label: 'Open rules', group: 'Action', run: () => (hide ? blocked() : setRulesOpen(true)) },
    { id: 'notif', label: 'Notification settings', group: 'Action', run: () => setNotifOpen(true) },
    { id: 'drafts', label: 'Open drafts', group: 'Action', run: () => (hide ? blocked() : setDraftsOpen(true)) },
    { id: 'sched', label: 'Scheduled messages', group: 'Action', run: () => (hide ? blocked() : setScheduledOpen(true)) },
    { id: 'kit', label: 'Choose a new media kit file', group: 'Action', run: () => void window.imc.invoke('mediaKit:choose').then(() => qc.invalidateQueries({ queryKey: ['mediakit'] })) },
    { id: 'search', label: 'Search mail', group: 'Action', run: () => document.getElementById('search-input')?.focus() },
    {
      id: 'ss',
      label: stream.active ? 'Turn stream-safe mode off' : 'Turn stream-safe mode on',
      group: 'Action',
      run: () =>
        void window.imc
          .invoke('streamsafe:set', { mode: stream.active ? 'off' : 'on' })
          .then((s) => qc.setQueryData(['streamsafe'], s))
    },
    { id: 'g-all', label: 'All inboxes', group: 'Go to', run: () => select({}) },
    { id: 'g-needs', label: 'Needs reply', group: 'Go to', run: () => select({ view: 'needsReply' }) },
    { id: 'g-wait', label: 'Waiting on reply', group: 'Go to', run: () => select({ view: 'waiting' }) },
    { id: 'g-fu', label: 'Follow-ups', group: 'Go to', run: () => select({ view: 'followUp' }) },
    { id: 'g-snz', label: 'Snoozed', group: 'Go to', run: () => select({ view: 'snoozed' }) },
    { id: 'g-sus', label: 'Suspicious mail', group: 'Go to', run: () => select({ view: 'suspicious' }) },
    { id: 'g-cal', label: 'Calendar', group: 'Go to', run: () => (hide ? blocked() : openCalendar()) },
    { id: 'g-board', label: 'Sponsorship board', group: 'Go to', run: () => (hide ? blocked() : openBoard()) },
    ...(hide
      ? []
      : [
          ...(folders.data ?? []).map((f) => ({
            id: 'f-' + f.id,
            label: `${accounts.data?.find((a) => a.id === f.accountId)?.displayName || accounts.data?.find((a) => a.id === f.accountId)?.email || ''} · ${f.name}`,
            group: 'Folder',
            run: () => select({ accountId: f.accountId, folderId: f.id })
          })),
          ...(labels.data ?? []).map((l) => ({ id: 'l-' + l.id, label: l.name, group: 'Label', run: () => select({ labelId: l.id }) })),
          ...(searches.data ?? []).map((q) => ({
            id: 's-' + q.id,
            label: q.name,
            group: 'Saved search',
            run: () => {
              select({})
              setQuery(q.query)
            }
          }))
        ])
  ]

  return (
    <div className="flex h-full">
      <Sidebar
        accounts={accounts.data ?? []}
        folders={folders.data ?? []}
        selection={selection}
        onSelect={select}
        onCompose={newMessage}
        onDrafts={() => (hide ? blocked() : setDraftsOpen(true))}
        streamSafe={stream}
        counts={counts.data}
        labels={labels.data ?? []}
        searches={searches.data ?? []}
        onRunSearch={(q) => {
          setBoard(false)
          setCalendar(false)
          setOpenId(null)
          setQuery(q)
        }}
        onDeleteSearch={(id) =>
          void window.imc.invoke('searches:delete', { id }).then(() => qc.invalidateQueries({ queryKey: ['searches'] }))
        }
        dealCount={(deals.data ?? []).filter((d) => ['lead', 'negotiating', 'contracted'].includes(d.stage)).length}
        boardActive={board}
        calendarActive={calendar}
        onCalendar={openCalendar}
        onBoard={openBoard}
        draftCount={drafts.data?.length ?? 0}
        scheduledCount={(outbox.data ?? []).filter((i) => i.scheduled && i.state === 'queued').length}
        onScheduled={() => (hide ? blocked() : setScheduledOpen(true))}
        onResync={(id) => void window.imc.invoke('accounts:resync', { id })}
        onMarkAll={(id, seen) => void markAll(id, seen)}
        onAddFolder={(accountId, parent) => (hide ? blocked() : setNewFolder({ accountId, parent }))}
        onDeleteFolder={(f) => void deleteFolder(f)}
        onRenameFolder={(f) => (hide ? blocked() : setRenaming(f))}
        onDropMessage={(ids, folderId) => void moveMany(ids, folderId)}
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
        onSaveSearch={(name) =>
          void window.imc.invoke('searches:save', { name, query }).then(() => qc.invalidateQueries({ queryKey: ['searches'] }))
        }
        footer={!searching && selection.folderId && !hide ? <LoadOlder key={selection.folderId} folderId={selection.folderId} onError={setComposeError} /> : null}
        selectedId={openId}
        forceCompact={composer !== null}
        checked={checked}
        onRowClick={clickRow}
        onBulk={(a) => void bulk(a)}
        onClearChecked={() => setChecked(new Set())}
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
      <DialogHost />
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
      {paletteOpen && <CommandPalette commands={streamer ? commands : commands.filter((c) => !STREAMER_COMMANDS.includes(c.id))} onClose={() => setPaletteOpen(false)} />}
      {newFolder && !hide && (
        <FolderNameDialog
          title={newFolder.parent ? 'New subfolder' : 'New folder'}
          where={
            newFolder.parent
              ? `Inside "${newFolder.parent.name}"`
              : `In ${accounts.data?.find((a) => a.id === newFolder.accountId)?.displayName || accounts.data?.find((a) => a.id === newFolder.accountId)?.email || 'this account'}`
          }
          onCreate={async (name) => {
            await window.imc.invoke('folders:create', { accountId: newFolder.accountId, parentId: newFolder.parent?.id, name })
            await qc.invalidateQueries()
          }}
          onClose={() => setNewFolder(null)}
        />
      )}
      {renaming && !hide && (
        <FolderNameDialog
          title="Rename folder"
          where="Mail inside it stays where it is."
          initial={renaming.name}
          confirmLabel="Rename"
          busyLabel="Renaming…"
          onCreate={async (name) => {
            await window.imc.invoke('folders:rename', { folderId: renaming.id, name })
            if (selection.folderId === renaming.id) select({})
            await qc.invalidateQueries()
          }}
          onClose={() => setRenaming(null)}
        />
      )}
      {reporting && <ReportDialog onClose={() => setReporting(false)} />}
      {rulesOpen && !hide && <RulesDialog onClose={() => setRulesOpen(false)} />}
      {notifOpen && <NotificationSettingsDialog onClose={() => setNotifOpen(false)} />}
      {adding && <AddAccount onClose={() => setAdding(false)} />}
    </div>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <WindowFrame>
        <Shell />
      </WindowFrame>
    </QueryClientProvider>
  )
}
