import { useState } from 'react'
import { BellRing } from 'lucide-react'
import { useOutside } from './ComposerMenus'
import { describeTime, followUpPresets, fromLocalInput, toLocalInput } from './schedule'

const item = 'flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-hover'

/** "Remind me if nobody replies": pick when, and the reminder drops away if someone answers first. */
export default function FollowUpMenu({
  className,
  onSet
}: {
  className: string
  onSet: (at: number) => void
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
        aria-label="Follow up"
        title="Remind me if nobody replies"
        aria-expanded={open}
        onClick={() => {
          setCustom(toLocalInput(Date.now() + 3 * 24 * 3600 * 1000))
          setOpen((v) => !v)
        }}
      >
        <BellRing size={16} strokeWidth={1.75} aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Remind me if nobody replies"
          className="absolute top-full right-0 z-20 mt-1 w-72 rounded-md border border-line-strong bg-raised py-2 text-base text-ink"
        >
          <p className="px-3 pb-1 text-sm text-ink-2">Remind me if there is no reply</p>
          {followUpPresets(new Date()).map((p) => (
            <button
              key={p.at}
              role="menuitem"
              className={item}
              onClick={() => {
                setOpen(false)
                onSet(p.at)
              }}
            >
              {p.label}
            </button>
          ))}
          <div className="mt-1 space-y-2 border-t border-line px-3 pt-2">
            <label className="block text-sm text-ink-2" htmlFor="followup-custom">
              Pick a date and time
            </label>
            <div className="flex gap-2">
              <input
                id="followup-custom"
                type="datetime-local"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                className="num h-8 min-w-0 flex-1 rounded-md border border-line-strong bg-sheet px-2 text-ink focus-visible:border-accent focus-visible:outline-offset-0"
              />
              <button
                disabled={!valid}
                onClick={() => {
                  setOpen(false)
                  if (chosen !== null) onSet(chosen)
                }}
                className="h-8 rounded-md border border-line-strong px-3 hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                Remind
              </button>
            </div>
            {valid && <p className="pb-1 text-xs text-ink-3">Reminder {describeTime(chosen!)}.</p>}
          </div>
        </div>
      )}
    </span>
  )
}
