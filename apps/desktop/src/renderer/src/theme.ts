import { useSyncExternalStore } from 'react'

export const THEMES = ['dark', 'mid', 'light'] as const
export type Theme = (typeof THEMES)[number]

const KEY = 'imc-theme'

export const isTheme = (v: unknown): v is Theme => THEMES.includes(v as Theme)

/** Stored choice wins; otherwise follow the OS (light OS -> Light, anything else -> Dark). */
export function resolveTheme(stored: string | null, prefersLight: boolean): Theme {
  if (isTheme(stored)) return stored
  return prefersLight ? 'light' : 'dark'
}

const listeners = new Set<() => void>()

const read = (): Theme => {
  const t = document.documentElement.dataset['theme']
  return isTheme(t) ? t : 'dark'
}

/** Call once before the first render so the right theme paints immediately. */
export function initTheme(): void {
  let stored: string | null = null
  try {
    stored = localStorage.getItem(KEY)
  } catch {
    /* storage unavailable: fall through to the OS preference */
  }
  document.documentElement.dataset['theme'] = resolveTheme(
    stored,
    window.matchMedia('(prefers-color-scheme: light)').matches
  )
}

export function setTheme(theme: Theme): void {
  document.documentElement.dataset['theme'] = theme
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    /* choice applies for this session only */
  }
  listeners.forEach((l) => l())
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
    read,
    () => 'dark'
  )
}
