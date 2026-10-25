import { useEffect, useMemo, useRef, useState } from 'react'

export interface Command {
  id: string
  label: string
  /** A short group name shown at the right, e.g. "Go to". */
  group: string
  run: () => void
}

/** Every word typed must appear somewhere in the label or group, in any order. */
export function filterCommands(commands: Command[], query: string): Command[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return commands
  return commands.filter((c) => {
    const hay = `${c.label} ${c.group}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

/** Ctrl+K: type to find an action or place, Enter to go. */
export default function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const shown = useMemo(() => filterCommands(commands, query), [commands, query])
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  useEffect(() => setActive(0), [query])

  const run = (c: Command | undefined) => {
    if (!c) return
    dialog.current?.close()
    c.run()
  }

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-label="Command palette"
      className="mx-auto mt-[12vh] w-xl max-w-[calc(100vw-2rem)] rounded-md border border-line-strong bg-raised p-0 text-ink"
    >
      <input
        autoFocus
        role="combobox"
        aria-expanded
        aria-controls="palette-list"
        aria-label="Type a command or a place"
        placeholder="Type a command or a place"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            if (shown.length > 0) setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length)
          } else if (e.key === 'Enter') {
            e.preventDefault()
            run(shown[active])
          }
        }}
        className="h-12 w-full border-b border-line bg-transparent px-4 text-md text-ink outline-none focus-visible:outline-none"
      />
      <ul id="palette-list" role="listbox" className="max-h-80 overflow-y-auto py-1">
        {shown.length === 0 && <li className="px-4 py-3 text-ink-3">Nothing matches.</li>}
        {shown.map((c, i) => (
          <li
            key={c.id}
            role="option"
            aria-selected={i === active}
            ref={(el) => {
              if (i === active) el?.scrollIntoView({ block: 'nearest' })
            }}
            onMouseMove={() => setActive(i)}
            onClick={() => run(c)}
            className={`flex cursor-default items-baseline gap-3 px-4 py-2 ${i === active ? 'bg-selected' : ''}`}
          >
            <span className="min-w-0 flex-1 truncate">{c.label}</span>
            <span className="shrink-0 text-sm text-ink-3">{c.group}</span>
          </li>
        ))}
      </ul>
    </dialog>
  )
}
