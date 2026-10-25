import { ShieldAlert, TriangleAlert } from 'lucide-react'
import type { RiskLevel } from '@imc/core'

/**
 * Scam-shield label for list rows: an icon and words, so it never depends on color. Mail the
 * shield has no objection to gets nothing.
 */
export default function RiskTag({ level }: { level: RiskLevel }) {
  if (level === 'none') return null
  const danger = level === 'danger'
  const Icon = danger ? ShieldAlert : TriangleAlert
  return (
    <span
      className={`flex shrink-0 items-center gap-1 rounded-sm border px-1.5 text-xs leading-4 ${
        danger ? 'border-alert text-alert' : 'border-line-strong text-ink-2'
      }`}
      title={danger ? 'This message looks like a scam' : 'This message has warning signs'}
    >
      <Icon size={11} strokeWidth={1.75} aria-hidden />
      {danger ? 'Likely scam' : 'Suspicious'}
    </span>
  )
}
