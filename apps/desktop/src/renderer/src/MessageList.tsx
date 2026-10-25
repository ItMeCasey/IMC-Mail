import { Check, Plus, Star } from 'lucide-react'
import BulkBar, { type BulkAction } from './BulkBar'
import CategoryTag from './CategoryTag'
import RiskTag from './RiskTag'
import { CalendarDays } from 'lucide-react'
import { describeTime } from './schedule'
import SearchBox from './SearchBox'
import type { Account, MessageSummary } from '@imc/core'
import { Private, priv } from './streamsafe'
import { tapeColor } from './tape'

const dayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

function formatDate(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  return d.toDateString() === new Date().toDateString() ? timeFmt.format(d) : dayFmt.format(d)
}

const th =
  'h-8 border-r border-line px-3 text-left text-sm font-medium text-ink-3 last:border-r-0'
const td = 'overflow-hidden text-ellipsis whitespace-nowrap px-3'

function Empty({
  hasAccounts,
  searching,
  onAdd
}: {
  hasAccounts: boolean
  searching: boolean
  onAdd: () => void
}) {
  return (
    <div className="grid flex-1 place-items-center p-8">
      <div className="max-w-sm space-y-3">
        <h2 className="text-lg font-semibold">
          {searching ? 'No matches' : hasAccounts ? 'Nothing on this sheet' : 'No accounts yet'}
        </h2>
        <p className="leading-(--leading-prose) text-ink-2">
          {hasAccounts
            ? 'This folder has no messages in the newest 200. New mail appears here as it arrives.'
            : 'Add a Google or Microsoft account, or any IMAP account with an app password. Every account gets its own tape color, so you can tell them apart at a glance.'}
        </p>
        {!hasAccounts && (
          <button
            onClick={onAdd}
            className="flex h-9 items-center gap-2 rounded-md bg-accent px-4 font-medium text-on-accent transition-colors duration-(--dur-fast) hover:bg-accent-hover"
          >
            <Plus size={16} strokeWidth={1.75} aria-hidden />
            Add account
          </button>
        )}
      </div>
    </div>
  )
}

/** Conversation size, drawn as a small outlined count so it reads without color. */
function ThreadCount({ n }: { n: number }) {
  if (n < 2) return null
  return (
    <span
      className="num grid h-4 min-w-4 place-items-center rounded-sm border border-line-strong px-1 text-xs text-ink-2"
      title={`${n} messages in this conversation`}
    >
      {n}
    </span>
  )
}

/** Marks mail that carries a meeting invitation. */
function InviteTag() {
  return (
    <span className="flex shrink-0 items-center gap-1 rounded-sm border border-line-strong px-1.5 text-xs leading-4 text-ink-2" title="Meeting invitation">
      <CalendarDays size={11} strokeWidth={1.75} aria-hidden />
      Invite
    </span>
  )
}

function Marks({ m }: { m: MessageSummary }) {
  return (
    <span className="flex items-center justify-end gap-2">
      <ThreadCount n={m.threadSize} />
      {m.starred && (
        <Star size={14} strokeWidth={1.75} className="fill-current text-ink" aria-label="Starred" />
      )}
      {m.unread && (
        <>
          <span className="mark mark-solid" aria-hidden />
          <span className="sr-only">Unread</span>
        </>
      )}
    </span>
  )
}

/** Lets a message be dropped on a folder in the sidebar. The tags say which account and folder it is from. */
function startDrag(e: React.DragEvent, m: MessageSummary, checked: Set<string>) {
  // Dragging a ticked message takes every ticked message with it.
  const ids = checked.has(m.id) ? [...checked] : [m.id]
  e.dataTransfer.setData('text/imc-message', ids.join(','))
  e.dataTransfer.setData(`application/x-imc-account-${m.accountId}`, '1')
  e.dataTransfer.setData(`application/x-imc-folder-${m.folderId}`, '1')
  e.dataTransfer.effectAllowed = 'move'
}

export default function MessageList({
  title,
  messages,
  accounts,
  loading,
  hide,
  footer,
  onSaveSearch,
  query,
  onQuery,
  searching,
  selectedId,
  forceCompact = false,
  checked,
  onRowClick,
  onBulk,
  onClearChecked,
  onSelect,
  onAdd
}: {
  title: string
  messages: MessageSummary[]
  accounts: Account[]
  loading: boolean
  /** Stream-safe mode: show bars instead of senders and subjects. */
  hide: boolean
  /** Shown under the list (the "load older mail" button). */
  footer?: React.ReactNode
  onSaveSearch?: (name: string) => void
  query: string
  onQuery: (q: string) => void
  searching: boolean
  selectedId: string | null
  /** Keep the narrow two-line layout even with no message open (the composer is showing). */
  forceCompact?: boolean
  /** Messages ticked for a bulk action. */
  checked: Set<string>
  /** A click on a row, with the modifier keys held: plain opens it, Ctrl ticks it, Shift ticks a range. */
  onRowClick: (id: string, keys: { ctrl: boolean; shift: boolean }) => void
  onBulk: (action: BulkAction) => void
  onClearChecked: () => void
  onSelect: (id: string) => void
  onAdd: () => void
}) {
  const color = new Map(accounts.map((a) => [a.id, a.color]))
  const email = new Map(accounts.map((a) => [a.id, a.email]))
  const empty = !loading && messages.length === 0
  // With a message open the sheet narrows to a two-line list so the reading pane has room.
  const compact = forceCompact || selectedId !== null

  const move = (delta: number) => {
    const i = messages.findIndex((m) => m.id === selectedId)
    const next = messages[Math.min(Math.max(i + delta, 0), messages.length - 1)]
    if (next) onSelect(next.id)
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault()
      move(1)
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault()
      move(-1)
    }
  }

  return (
    <section
      aria-label={title}
      className={`flex min-w-0 flex-col bg-sheet ${
        compact ? 'w-(--list-w) shrink-0 border-r border-line' : 'flex-1'
      }`}
    >
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
        <h1 className="truncate text-md font-semibold">{title}</h1>
        {!loading && messages.length > 0 && (
          <span className="num text-sm text-ink-3">
            {messages.length} {searching ? (messages.length === 1 ? 'result' : 'results') : 'threads'}
          </span>
        )}
        <SearchBox value={query} onChange={onQuery} onSave={onSaveSearch} />
      </header>
      {checked.size > 0 && <BulkBar count={checked.size} onAction={onBulk} onClear={onClearChecked} />}

      {empty ? (
        <Empty hasAccounts={accounts.length > 0} searching={searching} onAdd={onAdd} />
      ) : compact ? (
        <ul className="min-h-0 flex-1 overflow-y-auto" onKeyDown={onKeyDown}>
          {messages.map((m) => {
            const active = m.id === selectedId
            return (
              <li key={m.id} className="border-b border-line">
                <button
                  type="button"
                  draggable
                  onDragStart={(e) => startDrag(e, m, checked)}
                  aria-current={active ? 'true' : undefined}
                  onClick={(e) => onRowClick(m.id, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })}
                  className={`flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors duration-(--dur-fast) focus-visible:-outline-offset-2 ${
                    active || checked.has(m.id) ? 'bg-selected' : 'hover:bg-hover'
                  }`}
                >
                  <span
                    className="tape mt-1.5"
                    style={{ background: tapeColor(color.get(m.accountId)) }}
                    role="img"
                    aria-label={priv(hide, email.get(m.accountId) ?? 'Account', 'Account')}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span
                        className={`min-w-0 flex-1 truncate ${m.unread ? 'font-semibold text-ink' : 'text-ink-2'}`}
                      >
                        {checked.has(m.id) && <Check size={14} strokeWidth={2} aria-label="Selected" className="mr-1 inline text-ink" />}
                        <Private active={hide}>{m.fromName || m.fromAddr || '(unknown)'}</Private>
                      </span>
                      <time className="num shrink-0 text-sm text-ink-3">{m.snoozedUntil != null ? `Back ${describeTime(m.snoozedUntil)}` : m.followUpAt != null ? `Follow up ${describeTime(m.followUpAt)}` : formatDate(m.date)}</time>
                    </span>
                    <span className="mt-0.5 flex items-center gap-2">
                      <RiskTag level={m.risk} />
                      {m.invite && <InviteTag />}
                      <CategoryTag category={m.category} hide={hide} />
                      <span
                        className={`min-w-0 flex-1 truncate ${m.unread ? 'font-medium text-ink' : 'text-ink-2'}`}
                      >
                        <Private active={hide}>{m.subject || '(no subject)'}</Private>
                      </span>
                      <Marks m={m} />
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto" onKeyDown={onKeyDown}>
          <table className="w-full table-fixed border-collapse">
            <colgroup>
              <col className="w-14" />
              <col className="w-8" />
              <col className="w-56" />
              <col className="w-44" />
              <col />
              <col className="w-24" />
              <col className="w-24" />
            </colgroup>
            <thead className="sticky top-0 z-10 bg-rail">
              <tr className="border-b border-line">
                <th className={`${th} text-right`} scope="col">
                  No
                </th>
                <th className={th} scope="col">
                  <span className="sr-only">Account</span>
                </th>
                <th className={th} scope="col">
                  From
                </th>
                <th className={th} scope="col">
                  Type
                </th>
                <th className={th} scope="col">
                  Subject
                </th>
                <th className={`${th} text-right`} scope="col">
                  Date
                </th>
                <th className={th} scope="col">
                  <span className="sr-only">Marks</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {loading
                ? Array.from({ length: 10 }, (_, i) => (
                    <tr key={i} className="h-(--row-h) border-b border-line" aria-hidden>
                      <td colSpan={7} className="px-3">
                        <div
                          className="h-3 rounded-sm bg-hover"
                          style={{ width: `${55 + ((i * 17) % 40)}%` }}
                        />
                      </td>
                    </tr>
                  ))
                : messages.map((m, i) => (
                    <tr
                      key={m.id}
                      tabIndex={0}
                      draggable
                      onDragStart={(e) => startDrag(e, m, checked)}
                      onClick={(e) => onRowClick(m.id, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') onSelect(m.id)
                      }}
                      aria-selected={checked.has(m.id) || undefined}
                      className={`h-(--row-h) cursor-default border-b border-line transition-colors duration-(--dur-fast) hover:bg-hover focus-visible:-outline-offset-2 ${checked.has(m.id) ? 'bg-selected' : ''}`}
                    >
                      <td className={`${td} num text-right text-sm text-ink-3`}>{i + 1}</td>
                      <td className="px-3">
                        <span
                          className="tape"
                          style={{ background: tapeColor(color.get(m.accountId)) }}
                          role="img"
                          aria-label={priv(hide, email.get(m.accountId) ?? 'Account', 'Account')}
                        />
                      </td>
                      <td className={`${td} ${m.unread ? 'font-semibold text-ink' : 'text-ink-2'}`}>
                        {checked.has(m.id) && <Check size={14} strokeWidth={2} aria-label="Selected" className="mr-1 inline text-ink" />}
                        <Private active={hide}>{m.fromName || m.fromAddr || '(unknown)'}</Private>
                      </td>
                      <td className="px-3">
                        <span className="flex items-center gap-1.5">
                          <RiskTag level={m.risk} />
                          {m.invite && <InviteTag />}
                      {m.invite && <InviteTag />}
                          <CategoryTag category={m.category} hide={hide} />
                        </span>
                      </td>
                      <td className={`${td} ${m.unread ? 'font-medium text-ink' : 'text-ink-2'}`}>
                        <Private active={hide}>{m.subject || '(no subject)'}</Private>
                      </td>
                      <td className={`${td} num text-right text-sm text-ink-3`}>
                        {m.snoozedUntil != null ? `Back ${describeTime(m.snoozedUntil)}` : m.followUpAt != null ? `Follow up ${describeTime(m.followUpAt)}` : formatDate(m.date)}
                      </td>
                      <td className="px-3">
                        <Marks m={m} />
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
      )}
      {footer}
    </section>
  )
}
