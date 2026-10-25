import { Moon, Sun, SunMoon, type LucideIcon } from 'lucide-react'
import { setTheme, THEMES, useTheme, type Theme } from './theme'

const META: Record<Theme, { label: string; Icon: LucideIcon }> = {
  dark: { label: 'Dark', Icon: Moon },
  mid: { label: 'Mid', Icon: SunMoon },
  light: { label: 'Light', Icon: Sun }
}

export default function ThemeSwitch() {
  const current = useTheme()
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="flex divide-x divide-line overflow-hidden rounded-md border border-line-strong"
    >
      {THEMES.map((t) => {
        const { label, Icon } = META[t]
        const on = t === current
        return (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => setTheme(t)}
            className={`flex h-8 flex-1 items-center justify-center gap-1.5 text-sm transition-colors duration-(--dur-fast) focus-visible:-outline-offset-2 ${
              on ? 'bg-selected font-medium text-ink' : 'text-ink-2 hover:bg-hover hover:text-ink'
            }`}
          >
            <Icon size={14} strokeWidth={1.75} aria-hidden />
            {label}
          </button>
        )
      })}
    </div>
  )
}
