import { useState } from 'react'
import { EllipsisVertical, FolderPlus, MailCheck, MailOpen, RefreshCw } from 'lucide-react'
import { useOutside } from './ComposerMenus'

const item = 'flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-hover'

/** The three dots on an account: sync it, or mark everything in its Inbox read or unread. */
export default function AccountMenu({
  className,
  label,
  onSync,
  onMarkAll,
  onAddFolder
}: {
  className: string
  /** Account name for the screen reader (already hidden when stream-safe is on). */
  label: string
  onSync: () => void
  onMarkAll: (seen: boolean) => void
  onAddFolder: () => void
}) {
  const [open, setOpen] = useState(false)
  const root = useOutside(open, () => setOpen(false))
  const pick = (fn: () => void) => () => {
    setOpen(false)
    fn()
  }
  return (
    <span ref={root} className="relative">
      <button
        type="button"
        className={className}
        title="Account actions"
        aria-label={`Actions for ${label}`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        <EllipsisVertical size={14} strokeWidth={1.75} aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Account actions"
          className="absolute top-full right-0 z-30 mt-1 w-52 rounded-md border border-line-strong bg-raised py-1 text-base text-ink"
        >
          <button role="menuitem" className={item} onClick={pick(onSync)}>
            <RefreshCw size={14} strokeWidth={1.75} aria-hidden />
            Sync now
          </button>
          <button role="menuitem" className={item} onClick={pick(onAddFolder)}>
            <FolderPlus size={14} strokeWidth={1.75} aria-hidden />
            Add folder
          </button>
          <button role="menuitem" className={item} onClick={pick(() => onMarkAll(true))}>
            <MailCheck size={14} strokeWidth={1.75} aria-hidden />
            Mark all read
          </button>
          <button role="menuitem" className={item} onClick={pick(() => onMarkAll(false))}>
            <MailOpen size={14} strokeWidth={1.75} aria-hidden />
            Mark all unread
          </button>
        </div>
      )}
    </span>
  )
}
