import { useState } from 'react'
import {
  Archive,
  BadgeDollarSign,
  ChevronDown,
  ChevronRight,
  CalendarClock,
  AlarmClock,
  BellRing,
  Briefcase,
  Tag,
  Search,
  CalendarDays,
  Clock,
  Heart,
  MailWarning,
  Radio,
  Receipt,
  Users,
  FileText,
  Folder as FolderIcon,
  Inbox,
  Layers,
  type LucideIcon,
  PenLine,
  Reply,
  RefreshCw,
  Send,
  ShieldAlert,
  Star,
  Trash2,
  TriangleAlert,
  X
} from 'lucide-react'
import {
  CATEGORY_LABELS,
  PROTECTED_ROLES,
  type Account,
  type Label,
  type SavedSearch,
  type Category,
  type Folder,
  type FolderRole,
  type StreamSafeState,
  type ViewCounts
} from '@imc/core'
import { Private, priv } from './streamsafe'
import AccountMenu from './AccountMenu'
import FolderMenu from './FolderMenu'
import { folderRows } from './folderTree'
import type { Selection } from './hooks'
import { tapeColor } from './tape'

const ROLE_ICON: Record<FolderRole, LucideIcon> = {
  inbox: Inbox,
  sent: Send,
  drafts: FileText,
  trash: Trash2,
  junk: ShieldAlert,
  archive: Archive,
  all: Layers,
  starred: Star
}

const CATEGORY_ICON: Partial<Record<Category, LucideIcon>> = {
  sponsorship: BadgeDollarSign,
  collab: Users,
  platform: Radio,
  invoice: Receipt,
  fan: Heart,
  cold: MailWarning
}
const CATEGORY_ORDER: Category[] = ['sponsorship', 'collab', 'platform', 'invoice', 'fan', 'cold']

const iconProps = { size: 16, strokeWidth: 1.75, 'aria-hidden': true } as const

const row = (active: boolean) =>
  `flex h-8 w-full items-center gap-2 rounded-md pr-3 pl-2 text-left transition-colors duration-(--dur-fast) ${
    active ? 'bg-selected font-medium text-ink' : 'text-ink-2 hover:bg-hover hover:text-ink'
  }`

const iconBtn =
  'grid size-5 place-items-center rounded-sm text-ink-3 opacity-0 transition-opacity duration-(--dur-fast) hover:bg-hover hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100'

export default function Sidebar({
  accounts,
  folders,
  selection,
  onSelect,
  onCompose,
  onDrafts,
  draftCount,
  scheduledCount,
  onScheduled,
  streamSafe,
  counts,
  labels,
  searches,
  onRunSearch,
  onDeleteSearch,
  dealCount,
  boardActive,
  onBoard,
  calendarActive,
  onCalendar,
  onResync,
  onMarkAll,
  onDropMessage,
  onAddFolder,
  onDeleteFolder,
  onRenameFolder
}: {
  accounts: Account[]
  folders: Folder[]
  selection: Selection
  onSelect: (s: Selection) => void
  onCompose: () => void
  onDrafts: () => void
  draftCount: number
  scheduledCount: number
  onScheduled: () => void
  streamSafe: StreamSafeState
  counts: ViewCounts | undefined
  labels: Label[]
  searches: SavedSearch[]
  onRunSearch: (query: string) => void
  onDeleteSearch: (id: string) => void
  dealCount: number
  boardActive: boolean
  onBoard: () => void
  calendarActive: boolean
  onCalendar: () => void
  onResync: (id: string) => void
  onMarkAll: (id: string, seen: boolean) => void
  /** A message was dropped on a folder of its own account. */
  onDropMessage: (messageId: string, folderId: string) => void
  /** Make a folder in an account, inside `parent` if given. */
  onAddFolder: (accountId: string, parent: Folder | null) => void
  onDeleteFolder: (folder: Folder) => void
  onRenameFolder: (folder: Folder) => void
}) {
  // Which accounts are folded away; remembered between runs.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('imc.sidebar.collapsed') ?? '{}') as Record<string, boolean>
    } catch {
      return {}
    }
  })
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const toggle = (id: string) =>
    setCollapsed((c) => {
      const next = { ...c, [id]: !c[id] }
      try {
        localStorage.setItem('imc.sidebar.collapsed', JSON.stringify(next))
      } catch {
        /* the fold just is not remembered */
      }
      return next
    })
  const foldedUnread = (accountId: string) =>
    folders.filter((f) => f.accountId === accountId && f.role === 'inbox').reduce((n, f) => n + f.unread, 0)
  const unifiedUnread = folders.filter((f) => f.role === 'inbox').reduce((n, f) => n + f.unread, 0)
  const hide = streamSafe.active
  const isUnified =
    !boardActive && !calendarActive && !selection.accountId && !selection.folderId && !selection.view && !selection.category && !selection.labelId

  return (
    <nav
      aria-label="Accounts and folders"
      className="flex w-(--rail-w) shrink-0 flex-col border-r border-line bg-rail"
    >
      <div className="flex-1 space-y-5 overflow-y-auto p-3">
        <button
          onClick={onCompose}
          disabled={accounts.length === 0}
          className="flex h-9 w-full items-center justify-center gap-2 rounded-md bg-accent font-medium text-on-accent transition-colors duration-(--dur-fast) hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          <PenLine size={16} strokeWidth={1.75} aria-hidden />
          Compose
        </button>
        <button
          className={row(isUnified)}
          aria-current={isUnified ? 'page' : undefined}
          onClick={() => onSelect({})}
        >
          <Layers {...iconProps} />
          <span className="flex-1">All inboxes</span>
          {unifiedUnread > 0 && <span className="num min-w-6 text-right text-sm text-ink-2">{unifiedUnread}</span>}
        </button>

        <div className="space-y-0.5" role="group" aria-label="Smart views">
          <button
            className={row(!boardActive && selection.view === 'needsReply')}
            aria-current={!boardActive && selection.view === 'needsReply' ? 'page' : undefined}
            onClick={() => onSelect({ view: 'needsReply' })}
          >
            <Reply {...iconProps} />
            <span className="flex-1">Needs reply</span>
            {(counts?.needsReply ?? 0) > 0 && <span className="num min-w-6 text-right text-sm text-ink-2">{counts?.needsReply}</span>}
          </button>
          <button
            className={row(!boardActive && selection.view === 'waiting')}
            aria-current={!boardActive && selection.view === 'waiting' ? 'page' : undefined}
            onClick={() => onSelect({ view: 'waiting' })}
          >
            <Clock {...iconProps} />
            <span className="flex-1">Waiting on reply</span>
            {(counts?.waiting ?? 0) > 0 && <span className="num min-w-6 text-right text-sm text-ink-2">{counts?.waiting}</span>}
          </button>
          {(counts?.suspicious ?? 0) > 0 && (
            <button
              className={row(!boardActive && selection.view === 'suspicious')}
              aria-current={!boardActive && selection.view === 'suspicious' ? 'page' : undefined}
              onClick={() => onSelect({ view: 'suspicious' })}
            >
              <ShieldAlert {...iconProps} />
              <span className="flex-1">Suspicious</span>
              <span className="num min-w-6 text-right text-sm text-alert">{counts?.suspicious}</span>
            </button>
          )}
          {(counts?.snoozed ?? 0) > 0 && (
            <button
              className={row(!boardActive && selection.view === 'snoozed')}
              aria-current={!boardActive && selection.view === 'snoozed' ? 'page' : undefined}
              onClick={() => onSelect({ view: 'snoozed' })}
            >
              <AlarmClock {...iconProps} />
              <span className="flex-1">Snoozed</span>
              <span className="num min-w-6 text-right text-sm text-ink-2">{counts?.snoozed}</span>
            </button>
          )}
          {(counts?.followUp ?? 0) > 0 && (
            <button
              className={row(!boardActive && !calendarActive && selection.view === 'followUp')}
              aria-current={!boardActive && !calendarActive && selection.view === 'followUp' ? 'page' : undefined}
              onClick={() => onSelect({ view: 'followUp' })}
            >
              <BellRing {...iconProps} />
              <span className="flex-1">Follow-ups</span>
              <span className="num min-w-6 text-right text-sm text-ink-2">{counts?.followUp}</span>
            </button>
          )}
          <button className={row(calendarActive)} aria-current={calendarActive ? 'page' : undefined} onClick={onCalendar}>
            <CalendarDays {...iconProps} />
            <span className="flex-1">Calendar</span>
          </button>
          <button className={row(boardActive)} aria-current={boardActive ? 'page' : undefined} onClick={onBoard}>
            <Briefcase {...iconProps} />
            <span className="flex-1">Sponsorship board</span>
            {dealCount > 0 && <span className="num min-w-6 text-right text-sm text-ink-2">{dealCount}</span>}
          </button>
          {CATEGORY_ORDER.map((c) => {
            const n = counts?.categories.find((x) => x.category === c)
            if (!n || n.total === 0) return null
            const Icon = CATEGORY_ICON[c]!
            const active = !boardActive && selection.category === c
            return (
              <button
                key={c}
                className={row(active)}
                aria-current={active ? 'page' : undefined}
                onClick={() => onSelect({ category: c })}
              >
                <Icon {...iconProps} />
                <span className="flex-1">{CATEGORY_LABELS[c]}</span>
                {n.unread > 0 && <span className="num min-w-6 text-right text-sm text-ink-2">{n.unread}</span>}
              </button>
            )
          })}
        </div>

        {searches.length > 0 && (
          <div className="space-y-0.5" role="group" aria-label="Saved searches">
            {searches.map((q) => (
              <div key={q.id} className="group relative">
                <button className={row(false)} title={q.query} onClick={() => onRunSearch(q.query)}>
                  <Search {...iconProps} />
                  <span className="flex-1 truncate">{q.name}</span>
                </button>
                <button
                  className={`${iconBtn} absolute top-1/2 -right-2.5 -translate-y-1/2`}
                  aria-label={`Delete saved search ${q.name}`}
                  title="Delete saved search"
                  onClick={() => onDeleteSearch(q.id)}
                >
                  <X size={13} strokeWidth={1.75} aria-hidden />
                </button>
              </div>
            ))}
          </div>
        )}

        {labels.length > 0 && (
          <div className="space-y-0.5" role="group" aria-label="Labels">
            {labels.map((l) => {
              const active = !boardActive && !calendarActive && selection.labelId === l.id
              return (
                <button key={l.id} className={row(active)} aria-current={active ? 'page' : undefined} onClick={() => onSelect({ labelId: l.id })}>
                  <Tag {...iconProps} />
                  <span className="flex-1 truncate">{l.name}</span>
                  <span className="num min-w-6 text-right text-sm text-ink-2">{l.count}</span>
                </button>
              )
            })}
          </div>
        )}

        {accounts.map((a) => (
          <section key={a.id} aria-label={priv(hide, a.email, 'Account')} className="space-y-0.5">
            <div className="group relative flex items-center gap-2 pr-3 pb-1 pl-2">
              <button
                type="button"
                aria-expanded={!collapsed[a.id]}
                onClick={() => toggle(a.id)}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left hover:text-ink"
                title={hide ? undefined : a.email}
              >
                {collapsed[a.id] ? (
                  <ChevronRight size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-ink-3" />
                ) : (
                  <ChevronDown size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-ink-3" />
                )}
                <span className="tape" style={{ background: tapeColor(a.color) }} aria-hidden />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-2">
                  <Private active={hide}>{a.displayName || a.email}</Private>
                </span>
                {collapsed[a.id] && foldedUnread(a.id) > 0 && (
                  <span className="num min-w-6 text-right text-sm text-ink-2">{foldedUnread(a.id)}</span>
                )}
              </button>
              {(a.syncState === 'connecting' || a.syncState === 'syncing') && (
                <span className="flex items-center text-ink-3" title={a.syncState === 'connecting' ? 'Connecting' : 'Syncing'}>
                  <RefreshCw size={12} strokeWidth={1.75} className="animate-spin" aria-hidden />
                  <span className="sr-only">{a.syncState === 'connecting' ? 'Connecting' : 'Syncing'}</span>
                </span>
              )}
              <span className="absolute inset-y-0 -right-2.5 flex items-center">
                <AccountMenu
                  className={iconBtn}
                  label={priv(hide, a.email, 'account')}
                  onSync={() => onResync(a.id)}
                  onMarkAll={(seen) => onMarkAll(a.id, seen)}
                  onAddFolder={() => onAddFolder(a.id, null)}
                />
              </span>
            </div>

            {!collapsed[a.id] && a.syncState === 'error' && a.lastError && (
              <p
                role="status"
                className="mx-2 mb-1 flex items-start gap-1.5 text-sm leading-snug text-alert"
              >
                <TriangleAlert size={14} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden />
                <Private active={hide}>{a.lastError}</Private>
              </p>
            )}

            {!collapsed[a.id] &&
              folderRows(folders.filter((f) => f.accountId === a.id)).map(({ folder: f, depth }) => {
                const Icon = f.role ? ROLE_ICON[f.role] : FolderIcon
                const active = selection.folderId === f.id
                return (
                  <div key={f.id} className="group relative">
                  <button
                    style={depth > 0 ? { paddingLeft: `calc(0.5rem + ${depth} * 1rem)` } : undefined}
                    className={`${row(active)} ${dropTarget === f.id ? 'bg-selected outline outline-2 -outline-offset-2 outline-accent' : ''}`}
                    onDragOver={(e) => {
                      // Only a message from this account, and not from this same folder.
                      const t = e.dataTransfer.types
                      if (t.includes('text/imc-message') && t.includes(`application/x-imc-account-${a.id}`) && !t.includes(`application/x-imc-folder-${f.id}`)) {
                        e.preventDefault()
                        e.dataTransfer.dropEffect = 'move'
                        setDropTarget(f.id)
                      }
                    }}
                    onDragLeave={() => setDropTarget((d) => (d === f.id ? null : d))}
                    onDrop={(e) => {
                      e.preventDefault()
                      setDropTarget(null)
                      const id = e.dataTransfer.getData('text/imc-message')
                      if (id) onDropMessage(id, f.id)
                    }}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => onSelect({ accountId: a.id, folderId: f.id })}
                  >
                    <Icon {...iconProps} />
                    <span className="flex-1 truncate">{f.name}</span>
                    {f.unread > 0 && <span className="num min-w-6 text-right text-sm text-ink-2">{f.unread}</span>}
                  </button>
                  <span className="absolute inset-y-0 -right-2.5 flex items-center">
                    <FolderMenu
                      className={iconBtn}
                      label={priv(hide, f.name, 'folder')}
                      canDelete={!f.role || !PROTECTED_ROLES.includes(f.role as (typeof PROTECTED_ROLES)[number])}
                      onAddSubfolder={() => onAddFolder(a.id, f)}
                      onRename={() => onRenameFolder(f)}
                      onDelete={() => onDeleteFolder(f)}
                    />
                  </span>
                  </div>
                )
              })}
          </section>
        ))}
      </div>

      {(scheduledCount > 0 || draftCount > 0) && (
      <div className="space-y-2 border-t border-line p-3">
        {scheduledCount > 0 && (
          <button className={row(false)} onClick={onScheduled}>
            <CalendarClock {...iconProps} />
            <span className="flex-1">Scheduled</span>
            <span className="num min-w-6 text-right text-sm text-ink-2">{scheduledCount}</span>
          </button>
        )}
        {draftCount > 0 && (
          <button className={row(false)} onClick={onDrafts}>
            <FileText {...iconProps} />
            <span className="flex-1">Drafts</span>
            <span className="num min-w-6 text-right text-sm text-ink-2">{draftCount}</span>
          </button>
        )}

      </div>
      )}
    </nav>
  )
}
