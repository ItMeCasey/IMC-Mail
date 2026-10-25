import { useState } from 'react'
import { AlarmClock } from 'lucide-react'
import { useOutside } from './ComposerMenus'
import { describeTime, fromLocalInput, snoozePresets, toLocalInput } from './schedule'

const item = 'flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-hover'

/** Hide a message until later; it comes back at the top of the inbox as unread. */
export default function SnoozeMenu({
  className,
  onSnooze
}: {
  className: string
  onSnooze: (until: number) => void
}) {
  const [open, setOpen] = useState(false)
  const [custom, setCustom] = useState('')
  const root = useOutside(open, () => setOpen(false))
  const chosen = fromLocalInput(custom)
  const valid = chosen !== null && chosen > Date.now() + 60_000

  return (
    <span ref={root} className="relative">
      <button
        type="button"
        className={className}
        aria-label="Snooze"
        title="Snooze until later"
        aria-expanded={open}
        onClick={() => {
          setCustom(toLocalInput(Date.now() + 24 * 3600 * 1000))
          setOpen((v) => !v)
        }}
      >
        <AlarmClock size={16} strokeWidth={1.75} aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Snooze until"
          className="absolute top-full right-0 z-20 mt-1 w-72 rounded-md border border-line-strong bg-raised py-2 text-base text-ink"
        >
          <p className="px-3 pb-1 text-sm text-ink-2">Bring it back</p>
          {snoozePresets(new Date()).map((p) => (
            <button
              key={p.at}
              role="menuitem"
              className={item}
              onClick={() => {
                setOpen(false)
                onSnooze(p.at)
              }}
            >
              {p.label}
            </button>
          ))}
          <div className="mt-1 space-y-2 border-t border-line px-3 pt-2">
            <label className="block text-sm text-ink-2" htmlFor="snooze-custom">
              Pick a date and time
            </label>
            <div className="flex gap-2">
              <input
                id="snooze-custom"
                type="datetime-local"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                className="num h-8 min-w-0 flex-1 rounded-md border border-line-strong bg-sheet px-2 text-ink focus-visible:border-accent focus-visible:outline-offset-0"
              />
              <button
                disabled={!valid}
                onClick={() => {
                  setOpen(false)
                  if (chosen !== null) onSnooze(chosen)
                }}
                className="h-8 rounded-md border border-line-strong px-3 hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                Snooze
              </button>
            </div>
            {valid && <p className="pb-1 text-xs text-ink-3">Back {describeTime(chosen!)}.</p>}
          </div>
        </div>
      )}
    </span>
  )
}
