import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, ChevronDown, LayoutTemplate, Paperclip, Trash2 } from 'lucide-react'
import type { Template } from '@imc/core'
import { describeTime, fromLocalInput, schedulePresets, toLocalInput } from './schedule'

export const useOutside = (open: boolean, close: () => void) => {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', esc, true)
    return () => {
      window.removeEventListener('mousedown', away)
      window.removeEventListener('keydown', esc, true)
    }
  }, [open, close])
  return ref
}

const panel = 'absolute z-20 rounded-md border border-line-strong bg-raised py-1 text-base text-ink'
const item = 'flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-hover'

export const useTemplates = () =>
  useQuery({ queryKey: ['templates'], queryFn: () => window.imc.invoke('templates:list') })

/** Insert a saved reply, save the message as one, or delete old ones. */
export function TemplatesMenu({
  onPick,
  onSaveAs
}: {
  onPick: (t: Template) => void
  onSaveAs: () => void
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [managing, setManaging] = useState(false)
  const root = useOutside(open, () => setOpen(false))
  const templates = useTemplates()

  const remove = async (t: Template) => {
    if (!confirm(`Delete the template "${t.name}"?`)) return
    await window.imc.invoke('templates:delete', { id: t.id })
    await qc.invalidateQueries({ queryKey: ['templates'] })
  }

  return (
    <span ref={root} className="relative">
      <button
        type="button"
        aria-label="Templates"
        title="Templates"
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        className={`grid size-8 place-items-center rounded-md text-ink-2 transition-colors duration-(--dur-fast) hover:bg-hover hover:text-ink ${open ? 'bg-selected text-ink' : ''}`}
      >
        <LayoutTemplate size={16} strokeWidth={1.75} aria-hidden />
      </button>
      {open && (
        <div role="menu" aria-label="Templates" className={`${panel} top-full left-0 mt-1 w-72`}>
          {templates.data?.length === 0 && (
            <p className="px-3 py-2 text-sm text-ink-3">
              No templates yet. Write a reply you send often, then choose “Save this message as a template”.
            </p>
          )}
          <ul className="max-h-64 overflow-y-auto">
            {templates.data?.map((t) => (
              <li key={t.id} className="flex items-center">
                <button
                  role="menuitem"
                  className={`${item} min-w-0 flex-1`}
                  onClick={() => {
                    if (managing) return
                    setOpen(false)
                    onPick(t)
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{t.name}</span>
                  {t.attachments.length > 0 && (
                    <Paperclip size={12} strokeWidth={1.75} className="shrink-0 text-ink-3" aria-label={`${t.attachments.length} attachment`} />
                  )}
                </button>
                {managing && (
                  <button
                    aria-label={`Delete template ${t.name}`}
                    className="mr-1 grid size-7 place-items-center rounded-sm text-ink-3 hover:bg-hover hover:text-ink"
                    onClick={() => void remove(t)}
                  >
                    <Trash2 size={14} strokeWidth={1.75} aria-hidden />
                  </button>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-1 border-t border-line pt-1">
            <button
              role="menuitem"
              className={item}
              onClick={() => {
                setOpen(false)
                onSaveAs()
              }}
            >
              Save this message as a template…
            </button>
            {(templates.data?.length ?? 0) > 0 && (
              <button role="menuitem" className={`${item} text-ink-2`} onClick={() => setManaging((v) => !v)}>
                {managing ? 'Done deleting' : 'Delete templates…'}
              </button>
            )}
          </div>
        </div>
      )}
    </span>
  )
}

/** The arrow beside Send: pick a time instead of sending now. */
export function ScheduleMenu({
  disabled,
  onSchedule
}: {
  disabled: boolean
  onSchedule: (at: number) => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [custom, setCustom] = useState('')
  const root = useOutside(open, () => setOpen(false))
  const now = new Date()
  const chosen = fromLocalInput(custom)
  const valid = chosen !== null && chosen > Date.now() + 60_000

  return (
    <span ref={root} className="relative">
      <button
        type="button"
        aria-label="Schedule send"
        title="Schedule send"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          setCustom(toLocalInput(Date.now() + 24 * 3600 * 1000))
          setOpen((v) => !v)
        }}
        className="grid h-9 w-8 place-items-center rounded-r-md border-l border-on-accent/40 bg-accent text-on-accent transition-colors duration-(--dur-fast) hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
      >
        <ChevronDown size={16} strokeWidth={1.75} aria-hidden />
      </button>
      {open && (
        <div role="menu" aria-label="Schedule send" className={`${panel} bottom-full left-0 mb-1 w-80 py-2`}>
          <p className="flex items-center gap-2 px-3 pb-1 text-sm text-ink-2">
            <CalendarClock size={14} strokeWidth={1.75} aria-hidden />
            Send later
          </p>
          {schedulePresets(now).map((p) => (
            <button
              key={p.at}
              role="menuitem"
              className={item}
              onClick={() => {
                setOpen(false)
                onSchedule(p.at)
              }}
            >
              {p.label}
            </button>
          ))}
          <div className="mt-1 space-y-2 border-t border-line px-3 pt-2">
            <label className="block text-sm text-ink-2" htmlFor="sched-custom">
              Pick a date and time
            </label>
            <div className="flex gap-2">
              <input
                id="sched-custom"
                type="datetime-local"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                className="num h-8 min-w-0 flex-1 rounded-md border border-line-strong bg-sheet px-2 text-ink focus-visible:border-accent focus-visible:outline-offset-0"
              />
              <button
                disabled={!valid}
                onClick={() => {
                  setOpen(false)
                  if (chosen !== null) onSchedule(chosen)
                }}
                className="h-8 rounded-md border border-line-strong px-3 hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                Schedule
              </button>
            </div>
            {valid && <p className="text-xs text-ink-3">Goes out {describeTime(chosen!)}.</p>}
            <p className="pb-1 text-xs leading-snug text-ink-3">
              IMC-Mail needs to be open then. If it is closed, the message goes out the next time you open it.
            </p>
          </div>
        </div>
      )}
    </span>
  )
}
