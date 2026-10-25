import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ShieldCheck, ShieldOff } from 'lucide-react'
import type { StreamSafeMode, StreamSafeState } from '@imc/core'

const MODES: { id: StreamSafeMode; label: string; hint: string }[] = [
  { id: 'auto', label: 'Automatic', hint: 'On whenever streaming software is running' },
  { id: 'on', label: 'Always on', hint: 'Private content is always hidden' },
  { id: 'off', label: 'Off', hint: 'Never hide anything' }
]

function summary(s: StreamSafeState): string {
  if (s.overridden) return s.active ? 'Turned on with the hotkey' : 'Turned off with the hotkey'
  if (s.mode === 'on') return 'Always on'
  if (s.mode === 'off') return 'Off'
  return s.detected ? `Automatic: ${s.detected} is running` : 'Automatic: no streaming software'
}

export default function StreamSafeControl({ state, inline = false }: { state: StreamSafeState; inline?: boolean }) {
  const qc = useQueryClient()
  const [openPopover, setOpen] = useState(false)
  // Inline (in the settings panel) the options are always shown, in the page rather than a popover.
  const open = inline || openPopover
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', away)
      window.removeEventListener('keydown', esc)
    }
  }, [open])

  const set = (patch: { mode?: StreamSafeMode; hideFromCapture?: boolean }) =>
    void window.imc
      .invoke('streamsafe:set', patch)
      .then((s) => qc.setQueryData(['streamsafe'], s))

  const Icon = state.active ? ShieldCheck : ShieldOff

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-expanded={open}
        hidden={inline}
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-(--dur-fast) ${
          state.active ? 'bg-selected text-ink' : 'text-ink-2 hover:bg-hover hover:text-ink'
        }`}
      >
        <Icon size={16} strokeWidth={1.75} aria-hidden className="shrink-0" />
        <span className="min-w-0 flex-1">
          <span className={`block ${state.active ? 'font-medium' : ''}`}>
            Stream-safe {state.active ? 'on' : 'off'}
          </span>
          <span className="block truncate text-xs text-ink-3">{summary(state)}</span>
        </span>
      </button>

      {open && (
        <div
          role={inline ? undefined : 'dialog'}
          aria-label="Stream-safe mode"
          className={
            inline
              ? 'space-y-3'
              : 'absolute right-0 bottom-full left-0 z-20 mb-2 space-y-3 rounded-md border border-line-strong bg-raised p-3'
          }
        >
          <p className="text-sm leading-snug text-ink-2">
            Hides senders, subjects, message bodies, and account names, and keeps this window out
            of screen capture.
          </p>
          <div role="radiogroup" aria-label="When to hide" className="space-y-1">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={state.mode === m.id && !state.overridden}
                onClick={() => set({ mode: m.id })}
                className={`block w-full rounded-md px-2 py-1.5 text-left transition-colors duration-(--dur-fast) ${
                  state.mode === m.id && !state.overridden ? 'bg-selected' : 'hover:bg-hover'
                }`}
              >
                <span className="block font-medium">{m.label}</span>
                <span className="block text-xs text-ink-3">{m.hint}</span>
              </button>
            ))}
          </div>
          <label className="flex cursor-default items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={state.hideFromCapture}
              onChange={(e) => set({ hideFromCapture: e.target.checked })}
              className="mt-0.5"
            />
            <span>
              Hide this window from screen and window capture
              <span className="block text-xs text-ink-3">Shows as blank in OBS and screen shares.</span>
            </span>
          </label>
          <p className="text-xs text-ink-3">
            Ctrl+Shift+L flips it from anywhere, until streaming software starts or stops.
          </p>
        </div>
      )}
    </div>
  )
}
