import { Archive, Mail, MailOpen, ShieldAlert, Trash2, X } from 'lucide-react'

export type BulkAction = 'archive' | 'trash' | 'junk' | 'read' | 'unread'

const btn =
  'flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-ink-2 transition-colors duration-(--dur-fast) hover:bg-hover hover:text-ink'

/** Shown above the list while messages are ticked (Ctrl+click, Shift+click for a range). */
export default function BulkBar({
  count,
  onAction,
  onClear
}: {
  count: number
  onAction: (a: BulkAction) => void
  onClear: () => void
}) {
  return (
    <div role="toolbar" aria-label="Selected messages" className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line bg-selected px-4 py-1.5">
      <span className="num mr-2 text-sm font-medium">{count} selected</span>
      <button className={btn} onClick={() => onAction('archive')}>
        <Archive size={14} strokeWidth={1.75} aria-hidden />
        Archive
      </button>
      <button className={btn} onClick={() => onAction('trash')}>
        <Trash2 size={14} strokeWidth={1.75} aria-hidden />
        Trash
      </button>
      <button className={btn} onClick={() => onAction('junk')}>
        <ShieldAlert size={14} strokeWidth={1.75} aria-hidden />
        Junk
      </button>
      <button className={btn} onClick={() => onAction('read')}>
        <MailOpen size={14} strokeWidth={1.75} aria-hidden />
        Mark read
      </button>
      <button className={btn} onClick={() => onAction('unread')}>
        <Mail size={14} strokeWidth={1.75} aria-hidden />
        Mark unread
      </button>
      <span className="flex-1" />
      <button className={btn} onClick={onClear} aria-label="Clear selection" title="Clear selection (Esc)">
        <X size={14} strokeWidth={1.75} aria-hidden />
        Clear
      </button>
    </div>
  )
}
