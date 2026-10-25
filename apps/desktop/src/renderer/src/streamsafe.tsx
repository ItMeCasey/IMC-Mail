import { useEffect, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { EyeOff } from 'lucide-react'
import type { StreamSafeState } from '@imc/core'

const INACTIVE: StreamSafeState = {
  active: false,
  mode: 'auto',
  overridden: false,
  detected: null,
  hideFromCapture: true,
  watch: []
}

/** Mirrors the main process's stream-safe state; updates arrive as pushes. */
export function useStreamSafe(): StreamSafeState {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['streamsafe'],
    queryFn: () => window.imc.invoke('streamsafe:get'),
    staleTime: Infinity
  })
  useEffect(
    () => window.imc.on('streamsafe:changed', (s) => qc.setQueryData(['streamsafe'], s)),
    [qc]
  )
  // Until the first answer arrives, assume protected: showing nothing beats a flash of mail.
  return q.data ?? { ...INACTIVE, active: true }
}

/**
 * Text that must not appear while stream-safe mode is on. When active it renders a flat bar of
 * roughly the same length, and the real string never reaches the DOM.
 */
export function Private({
  active,
  children
}: {
  active: boolean
  children: string | null | undefined
}) {
  const text = children ?? ''
  if (!active) return <>{text}</>
  const em = Math.min(Math.max(text.length, 4), 36) * 0.5
  return (
    <span
      role="img"
      aria-label="Hidden"
      className="redacted"
      style={{ width: `${em}em` }}
    />
  )
}

/** A string safe for attributes (title, aria-label) that would otherwise leak. */
export const priv = (active: boolean, text: string, fallback = 'Hidden'): string =>
  active ? fallback : text

export function HiddenNotice({ what }: { what: string }) {
  return (
    <section className="grid min-w-0 flex-1 place-items-center bg-sheet p-8" aria-label={what}>
      <div className="max-w-sm space-y-2 text-center">
        <EyeOff size={20} strokeWidth={1.75} className="mx-auto text-ink-3" aria-hidden />
        <h2 className="text-md font-semibold">Hidden while stream-safe mode is on</h2>
        <p className="leading-(--leading-prose) text-ink-2">
          Press Ctrl+Shift+L to show {what.toLowerCase()}, or change the mode in the sidebar.
        </p>
      </div>
    </section>
  )
}
