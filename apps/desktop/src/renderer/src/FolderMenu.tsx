import { useState } from 'react'
import { EllipsisVertical, FolderPlus, Pencil, Trash2 } from 'lucide-react'
import { useOutside } from './ComposerMenus'

const item = 'flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-hover'

/** The dots on a folder: make a folder inside it, or delete it (standard folders cannot be deleted). */
export default function FolderMenu({
  className,
  label,
  canDelete,
  onAddSubfolder,
  onRename,
  onDelete
}: {
  className: string
  label: string
  canDelete: boolean
  onAddSubfolder: () => void
  onRename: () => void
  onDelete: () => void
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
        title="Folder actions"
        aria-label={`Actions for folder ${label}`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        <EllipsisVertical size={14} strokeWidth={1.75} aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Folder actions"
          className="absolute top-full right-0 z-30 mt-1 w-52 rounded-md border border-line-strong bg-raised py-1 text-base text-ink"
        >
          <button role="menuitem" className={item} onClick={pick(onAddSubfolder)}>
            <FolderPlus size={14} strokeWidth={1.75} aria-hidden />
            Add subfolder
          </button>
          {canDelete && (
            <button role="menuitem" className={item} onClick={pick(onRename)}>
              <Pencil size={14} strokeWidth={1.75} aria-hidden />
              Rename folder
            </button>
          )}
          {canDelete && (
            <button role="menuitem" className={`${item} text-alert`} onClick={pick(onDelete)}>
              <Trash2 size={14} strokeWidth={1.75} aria-hidden />
              Delete folder
            </button>
          )}
        </div>
      )}
    </span>
  )
}
