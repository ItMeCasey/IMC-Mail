import {
  Archive,
  FileText,
  Folder as FolderIcon,
  Inbox,
  Layers,
  type LucideIcon,
  PenLine,
  Plus,
  RefreshCw,
  Send,
  ShieldAlert,
  Star,
  Trash2,
  TriangleAlert,
  X
} from 'lucide-react'
import type { Account, Folder, FolderRole, StreamSafeState } from '@imc/core'
import { Private, priv } from './streamsafe'
import StreamSafeControl from './StreamSafeControl'
import type { Selection } from './hooks'
import { tapeColor } from './tape'
import ThemeSwitch from './ThemeSwitch'

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

const iconProps = { size: 16, strokeWidth: 1.75, 'aria-hidden': true } as const

const row = (active: boolean) =>
  `flex h-8 w-full items-center gap-2 rounded-md px-2 text-left transition-colors duration-(--dur-fast) ${
    active ? 'bg-selected font-medium text-ink' : 'text-ink-2 hover:bg-hover hover:text-ink'
  }`

const iconBtn =
  'grid size-6 place-items-center rounded-sm text-ink-3 opacity-0 transition-opacity duration-(--dur-fast) hover:bg-hover hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100'

export default function Sidebar({
  accounts,
  folders,
  selection,
  onSelect,
  onAdd,
  onCompose,
  onDrafts,
  draftCount,
  streamSafe,
  onRemove,
  onResync
}: {
  accounts: Account[]
  folders: Folder[]
  selection: Selection
  onSelect: (s: Selection) => void
  onAdd: () => void
  onCompose: () => void
  onDrafts: () => void
  draftCount: number
  streamSafe: StreamSafeState
  onRemove: (id: string) => void
  onResync: (id: string) => void
}) {
  const unifiedUnread = folders.filter((f) => f.role === 'inbox').reduce((n, f) => n + f.unread, 0)
  const hide = streamSafe.active
  const isUnified = !selection.accountId && !selection.folderId

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
          {unifiedUnread > 0 && <span className="num text-sm text-ink-2">{unifiedUnread}</span>}
        </button>

        {accounts.map((a) => (
          <section key={a.id} aria-label={priv(hide, a.email, 'Account')} className="space-y-0.5">
            <div className="group flex items-center gap-2 px-2 pb-1">
              <span className="tape" style={{ background: tapeColor(a.color) }} aria-hidden />
              <span
                className="min-w-0 flex-1 truncate text-sm font-medium text-ink-2"
                title={hide ? undefined : a.email}
              >
                <Private active={hide}>{a.displayName || a.email}</Private>
              </span>
              {(a.syncState === 'connecting' || a.syncState === 'syncing') && (
                <span className="flex items-center gap-1 text-xs text-ink-3">
                  <RefreshCw size={12} strokeWidth={1.75} className="animate-spin" aria-hidden />
                  {a.syncState === 'connecting' ? 'Connecting' : 'Syncing'}
                </span>
              )}
              <button
                className={iconBtn}
                title="Sync now"
                aria-label={`Sync ${priv(hide, a.email, 'account')} now`}
                onClick={() => onResync(a.id)}
              >
                <RefreshCw size={13} strokeWidth={1.75} aria-hidden />
              </button>
              <button
                className={iconBtn}
                title="Remove account"
                aria-label={`Remove ${priv(hide, a.email, 'account')}`}
                onClick={() => {
                  if (confirm(`Remove ${priv(hide, a.email, 'this account')}? Cached mail is deleted from this computer only.`))
                    onRemove(a.id)
                }}
              >
                <X size={13} strokeWidth={1.75} aria-hidden />
              </button>
            </div>

            {a.syncState === 'error' && a.lastError && (
              <p
                role="status"
                className="mx-2 mb-1 flex items-start gap-1.5 text-sm leading-snug text-alert"
              >
                <TriangleAlert size={14} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden />
                <Private active={hide}>{a.lastError}</Private>
              </p>
            )}

            {folders
              .filter((f) => f.accountId === a.id)
              .map((f) => {
                const Icon = f.role ? ROLE_ICON[f.role] : FolderIcon
                const active = selection.folderId === f.id
                return (
                  <button
                    key={f.id}
                    className={row(active)}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => onSelect({ accountId: a.id, folderId: f.id })}
                  >
                    <Icon {...iconProps} />
                    <span className="flex-1 truncate">{f.name}</span>
                    {f.unread > 0 && <span className="num text-sm text-ink-2">{f.unread}</span>}
                  </button>
                )
              })}
          </section>
        ))}
      </div>

      <div className="space-y-2 border-t border-line p-3">
        {draftCount > 0 && (
          <button className={row(false)} onClick={onDrafts}>
            <FileText {...iconProps} />
            <span className="flex-1">Drafts</span>
            <span className="num text-sm text-ink-2">{draftCount}</span>
          </button>
        )}
        <StreamSafeControl state={streamSafe} />
        <ThemeSwitch />
        <button
          onClick={onAdd}
          className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-line-strong text-ink transition-colors duration-(--dur-fast) hover:bg-hover"
        >
          <Plus size={16} strokeWidth={1.75} aria-hidden />
          Add account
        </button>
      </div>
    </nav>
  )
}
