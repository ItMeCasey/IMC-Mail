import type { Folder, Summary } from '@imc/mail'
import type { PhoneAccount } from './auth'

/** Everything the app can show. The back and forward gestures walk through a list of these. */
export type Screen =
  | { name: 'tab'; tab: Tab }
  | { name: 'message'; account: PhoneAccount; folder: Folder; summary: Summary }
  | { name: 'compose'; account: PhoneAccount; start?: ComposeStart }
  | { name: 'addAccount' }
  | { name: 'devices' }
  | { name: 'diagnostics' }

export type Tab = 'mail' | 'calendar' | 'deals' | 'settings'

/** What a new message starts with, for a reply or forward. */
export interface ComposeStart {
  to: string
  cc: string
  /** Blind copies, when the message came from a link that names them. */
  bcc?: string
  subject: string
  text: string
  inReplyTo: string | null
  references: string[]
}

export const describeError = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export const newId = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

export const when = (ms: number | null): string => {
  if (ms === null) return ''
  const d = new Date(ms)
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}
