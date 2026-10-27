import { useQuery } from '@tanstack/react-query'
import { logoDomain } from '@imc/mail/logo'

// Company logos next to senders in the message list. The pictures come from the main process (the window may not load
// anything from the web itself), which keeps them on disk; this only asks for the domains on screen.

/** The logo of each sender's company, by sender address. Nothing is asked for while the setting is off or senders are hidden. */
export function useLogos(addresses: (string | null | undefined)[], hide: boolean): { on: boolean; logoFor: (address: string | null | undefined) => string | null } {
  const prefs = useQuery({ queryKey: ['prefs'], queryFn: () => window.imc.invoke('app:prefs') })
  const on = (prefs.data?.showLogos ?? false) && !hide
  const domains = [...new Set(addresses.map(logoDomain).filter((d): d is string => d !== null))].sort()
  const logos = useQuery({
    queryKey: ['logos', domains.join(',')],
    queryFn: () => window.imc.invoke('logos:get', { domains }),
    enabled: on && domains.length > 0,
    staleTime: Infinity,
    placeholderData: (previous) => previous
  })
  return {
    on,
    logoFor: (address) => {
      const d = logoDomain(address)
      return on && d ? (logos.data?.[d] ?? null) : null
    }
  }
}

/** A small square mark for a sender: the company's logo when there is one, otherwise their first letter. */
export function Logo({ logo, name, size = 20 }: { logo: string | null; name: string; size?: number }) {
  if (logo) {
    return <img src={logo} alt="" width={size} height={size} className="shrink-0 rounded-sm bg-white object-contain p-0.5" style={{ width: size, height: size }} />
  }
  return (
    <span aria-hidden className="flex shrink-0 items-center justify-center rounded-sm border border-line text-xs font-semibold text-ink-3" style={{ width: size, height: size }}>
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  )
}
