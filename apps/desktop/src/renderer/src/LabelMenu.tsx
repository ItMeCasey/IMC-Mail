import { useState } from 'react'
import { Check, Tag } from 'lucide-react'
import type { Label } from '@imc/core'
import { useOutside } from './ComposerMenus'

const item = 'flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-hover'

/** Tick the labels a message carries; type a name to make a new one. Labels stay on this computer. */
export default function LabelMenu({
  className,
  labels,
  selected,
  onChange,
  onCreate
}: {
  className: string
  labels: Label[]
  selected: string[]
  onChange: (ids: string[]) => void
  onCreate: (name: string) => Promise<Label>
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const root = useOutside(open, () => setOpen(false))
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])
  const create = async () => {
    const n = name.trim()
    if (!n) return
    const l = await onCreate(n)
    setName('')
    if (!selected.includes(l.id)) onChange([...selected, l.id])
  }
  return (
    <span ref={root} className="relative">
      <button type="button" className={className} aria-label="Labels" title="Labels" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Tag size={16} strokeWidth={1.75} aria-hidden />
      </button>
      {open && (
        <div role="menu" aria-label="Labels" className="absolute top-full right-0 z-20 mt-1 w-64 rounded-md border border-line-strong bg-raised py-1 text-base text-ink">
          {labels.length === 0 && <p className="px-3 py-1.5 text-sm text-ink-3">No labels yet. Make one below.</p>}
          <div className="max-h-56 overflow-y-auto">
            {labels.map((l) => (
              <button key={l.id} role="menuitemcheckbox" aria-checked={selected.includes(l.id)} className={item} onClick={() => toggle(l.id)}>
                <span className="grid size-4 place-items-center">{selected.includes(l.id) && <Check size={14} strokeWidth={1.75} aria-hidden />}</span>
                <span className="truncate">{l.name}</span>
              </button>
            ))}
          </div>
          <form
            className="mt-1 flex gap-2 border-t border-line px-3 pt-2 pb-1"
            onSubmit={(e) => {
              e.preventDefault()
              void create()
            }}
          >
            <input
              aria-label="New label"
              value={name}
              maxLength={40}
              placeholder="New label"
              onChange={(e) => setName(e.target.value)}
              className="h-8 min-w-0 flex-1 rounded-md border border-line-strong bg-sheet px-2 text-ink"
            />
            <button disabled={!name.trim()} className="h-8 rounded-md border border-line-strong px-3 hover:bg-hover disabled:opacity-50">
              Add
            </button>
          </form>
          <p className="px-3 pt-1 pb-1 text-xs text-ink-3">Labels are kept on this computer only.</p>
        </div>
      )}
    </span>
  )
}
