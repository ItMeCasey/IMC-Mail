import type { Category, NotificationSettings, RiskLevel } from '@imc/core'

export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  enabled: true,
  // The mail a creator acts on. Fan mail and cold outreach can wait for a look at the inbox.
  categories: ['sponsorship', 'collab', 'platform', 'invoice', 'other'],
  quietHours: { enabled: false, start: '22:00', end: '08:00' },
  whenStreamSafe: 'silent'
}

export interface Incoming {
  id: string
  fromName: string
  fromAddr: string
  subject: string
  category: Category
  risk: RiskLevel
  date: number
  unread: boolean
}

export interface Toast {
  title: string
  body: string
  /** The message to open when the notification is clicked. */
  messageId: string | null
}

const minutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

/** True while quiet hours are in force, including a window that crosses midnight. */
export function inQuietHours(s: NotificationSettings['quietHours'], now: Date): boolean {
  if (!s.enabled) return false
  const t = now.getHours() * 60 + now.getMinutes()
  const a = minutes(s.start)
  const b = minutes(s.end)
  if (a === b) return false
  return a < b ? t >= a && t < b : t >= a || t < b
}

/** Mail older than this when it is first seen is catch-up, not news. */
export const FRESH_MS = 15 * 60 * 1000

/** Why a message would not raise a notification, or null if it would. */
export function skipReason(
  m: Incoming,
  s: NotificationSettings,
  now: Date,
  streamActive: boolean
): string | null {
  if (!s.enabled) return 'Notifications are off'
  if (streamActive && s.whenStreamSafe === 'silent') return 'Stream-safe mode is on'
  if (inQuietHours(s.quietHours, now)) return 'Quiet hours'
  if (!m.unread) return 'Already read'
  if (m.risk === 'danger') return 'Looks like a scam'
  if (now.getTime() - m.date > FRESH_MS) return 'Not new'
  if (!s.categories.includes(m.category)) return 'Category is muted'
  return null
}

const display = (m: Incoming) => m.fromName.trim() || m.fromAddr

/** One toast for a burst of new mail: details for one message, a tally for several. */
export function composeToast(
  items: Incoming[],
  s: NotificationSettings,
  streamActive: boolean
): Toast | null {
  if (items.length === 0) return null
  // Hidden details: nothing that names a sender or a subject.
  if (streamActive) {
    return {
      title: 'IMC-Mail',
      body: items.length === 1 ? 'New message' : `${items.length} new messages`,
      messageId: null
    }
  }
  if (items.length === 1) {
    const m = items[0]!
    return { title: display(m), body: m.subject || '(no subject)', messageId: m.id }
  }
  const names = [...new Set(items.map(display))]
  const shown = names.slice(0, 3).join(', ')
  const more = names.length > 3 ? `, +${names.length - 3} more` : ''
  return { title: `${items.length} new messages`, body: shown + more, messageId: items[0]!.id }
}

/**
 * Collects new-mail events for a moment so a burst becomes one toast, applies the rules, and
 * hands the result to `show`. Kept free of Electron so it can be tested.
 */
export class Notifier {
  private pending: Incoming[] = []
  private timer: NodeJS.Timeout | null = null

  constructor(
    private deps: {
      getSettings: () => NotificationSettings
      streamActive: () => boolean
      /** Looks up cached messages by id. */
      load: (ids: string[]) => Incoming[]
      /** Looks up cached messages you sent, for follow-up reminders. */
      loadSent?: (ids: string[]) => Incoming[]
      show: (t: Toast) => void
      now?: () => Date
      batchMs?: number
    }
  ) {}

  private now = () => (this.deps.now ?? (() => new Date()))()

  /** Message ids that just arrived in an inbox. */
  handleNew(ids: string[]): void {
    const settings = this.deps.getSettings()
    const active = this.deps.streamActive()
    const now = this.now()
    for (const m of this.deps.load(ids)) {
      if (skipReason(m, settings, now, active) === null) this.pending.push(m)
    }
    if (this.pending.length === 0 || this.timer) return
    this.timer = setTimeout(() => this.flush(), this.deps.batchMs ?? 1500)
  }

  /**
   * Snoozed mail that just came back. It is old by definition, so the freshness, read, and
   * category rules do not apply; the on/off switch, quiet hours, scam check, and stream-safe
   * behavior still do.
   */
  handleWake(ids: string[]): void {
    const settings = this.deps.getSettings()
    const active = this.deps.streamActive()
    const now = this.now()
    if (!settings.enabled || inQuietHours(settings.quietHours, now)) return
    if (active && settings.whenStreamSafe === 'silent') return
    for (const m of this.deps.load(ids)) {
      if (m.risk === 'danger') continue
      this.pending.push({ ...m, subject: `Snoozed: ${m.subject || '(no subject)'}`, unread: true })
    }
    if (this.pending.length === 0 || this.timer) return
    this.timer = setTimeout(() => this.flush(), this.deps.batchMs ?? 1500)
  }

  /** A follow-up reminder came due: nobody replied to what you sent. */
  handleFollowUp(ids: string[]): void {
    const settings = this.deps.getSettings()
    if (!settings.enabled || inQuietHours(settings.quietHours, this.now())) return
    if (this.deps.streamActive() && settings.whenStreamSafe === 'silent') return
    for (const m of (this.deps.loadSent?.(ids) ?? [])) {
      this.pending.push({ ...m, subject: `No reply yet: ${m.subject || '(no subject)'}` })
    }
    if (this.pending.length === 0 || this.timer) return
    this.timer = setTimeout(() => this.flush(), this.deps.batchMs ?? 1500)
  }

  flush(): void {
    this.timer = null
    const items = this.pending
    this.pending = []
    // Stream-safe may have turned on while the burst was collecting.
    const toast = composeToast(items, this.deps.getSettings(), this.deps.streamActive())
    if (toast) this.deps.show(toast)
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending = []
  }
}
