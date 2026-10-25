/** Account colors are stored as hex; the UI maps them onto the theme-aware tape tokens. */
const STORED = [
  '#6366f1',
  '#10b981',
  '#f59e0b',
  '#ec4899',
  '#06b6d4',
  '#8b5cf6',
  '#ef4444',
  '#84cc16'
]

export function tapeColor(stored: string | undefined): string {
  const i = stored ? STORED.indexOf(stored.toLowerCase()) : -1
  return i >= 0 ? `var(--tape-${i + 1})` : (stored ?? 'var(--ink-3)')
}
