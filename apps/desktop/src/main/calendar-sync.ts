import {
  googleEventsUrl,
  googleNextPage,
  graphEventsUrl,
  graphNextLink,
  parseGoogleEvents,
  parseGraphEvents,
  SYNC_AHEAD_MS,
  SYNC_PAST_MS,
  type RemoteEvent
} from '@imc/core'
import { CalendarNotConnected } from './oauth'
import type { MailStore } from './store'

export type CalendarSyncResult = { state: 'connected' } | { state: 'not-connected' } | { state: 'error'; error: string }

const MAX_PAGES = 10
const EVERY_MS = 10 * 60_000

/** What Google or Microsoft said went wrong, in a sentence a person can act on. */
async function problemFrom(res: Response): Promise<string> {
  let message = ''
  let reason = ''
  try {
    const j = (await res.json()) as { error?: { message?: string; code?: string; errors?: { reason?: string }[] } | string }
    if (typeof j.error === 'object' && j.error) {
      message = String(j.error.message ?? '').slice(0, 200)
      reason = String(j.error.errors?.[0]?.reason ?? j.error.code ?? '')
    }
  } catch {
    // no readable body
  }
  if (reason === 'accessNotConfigured' || /has not been used|is disabled/i.test(message)) {
    return 'The Google Calendar API is turned off for your Google Cloud project. Turn it on (see docs/oauth-setup.md), then try again.'
  }
  if (res.status === 401) return 'Sign-in for the calendar expired. Connect the calendar again.'
  if (res.status === 429) return 'The calendar service asked us to slow down. It will retry soon.'
  return `The calendar service answered ${res.status}${message ? `: ${message}` : ''}.`
}

class CalendarHttpError extends Error {}

/**
 * Keeps a read-only copy of each Microsoft and Google account's calendar, next to the meetings that
 * came by email. Repeating meetings arrive already expanded, so nothing here knows about recurrence.
 */
export class CalendarSync {
  private timer: NodeJS.Timeout | null = null
  private inflight = new Map<string, Promise<CalendarSyncResult>>()

  constructor(
    private deps: {
      store: MailStore
      calendarToken: (accountId: string) => Promise<string>
      onChange: (accountId: string) => void
      fetchFn?: typeof fetch
      now?: () => number
    }
  ) {}

  private now = () => (this.deps.now ?? Date.now)()

  start(): void {
    if (this.timer) return
    setTimeout(() => void this.syncAll(), 20_000)
    this.timer = setInterval(() => void this.syncAll(), EVERY_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Accounts that can have a calendar: Microsoft and Google sign-ins. */
  private calendarAccounts() {
    return this.deps.store.listAccounts().filter((a) => a.provider === 'gmail' || a.provider === 'microsoft')
  }

  async syncAll(): Promise<void> {
    for (const a of this.calendarAccounts()) await this.syncAccount(a.id)
  }

  /** Reads one account's calendar. Safe to call often: a second call while one runs shares its answer. */
  syncAccount(accountId: string): Promise<CalendarSyncResult> {
    let p = this.inflight.get(accountId)
    if (!p) {
      p = this.run(accountId).finally(() => this.inflight.delete(accountId))
      this.inflight.set(accountId, p)
    }
    return p
  }

  private async run(accountId: string): Promise<CalendarSyncResult> {
    const { store } = this.deps
    const account = this.calendarAccounts().find((a) => a.id === accountId)
    if (!account) return { state: 'not-connected' }
    try {
      const token = await this.deps.calendarToken(accountId)
      const from = this.now() - SYNC_PAST_MS
      const to = this.now() + SYNC_AHEAD_MS
      const events = account.provider === 'microsoft' ? await this.readGraph(token, from, to) : await this.readGoogle(token, from, to)
      store.replaceRemoteEvents(accountId, from, to, events)
      store.setRemoteSync(accountId, this.now(), null)
      this.deps.onChange(accountId)
      return { state: 'connected' }
    } catch (e) {
      if (e instanceof CalendarNotConnected) {
        const had = store.remoteSyncStates().some((s) => s.accountId === accountId)
        store.clearRemoteEvents(accountId)
        if (had) this.deps.onChange(accountId)
        return { state: 'not-connected' }
      }
      const error = e instanceof Error ? e.message : String(e)
      store.setRemoteSync(accountId, null, error)
      return { state: 'error', error }
    }
  }

  private async get(url: string, token: string, extra: Record<string, string> = {}): Promise<unknown> {
    let res: Response
    try {
      res = await (this.deps.fetchFn ?? fetch)(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...extra },
        signal: AbortSignal.timeout(20_000)
      })
    } catch {
      throw new CalendarHttpError('Could not reach the calendar service. Check your connection.')
    }
    if (!res.ok) {
      // 401/403 right after consent can mean the permission was removed: treat a refused scope as not connected.
      if (res.status === 403 && /insufficient|scope/i.test(res.headers.get('www-authenticate') ?? '')) throw new CalendarNotConnected()
      throw new CalendarHttpError(await problemFrom(res))
    }
    return res.json()
  }

  private async readGraph(token: string, from: number, to: number): Promise<RemoteEvent[]> {
    const out: RemoteEvent[] = []
    let url: string | null = graphEventsUrl(from, to)
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const json = await this.get(url, token, { Prefer: 'outlook.timezone="UTC"' })
      out.push(...parseGraphEvents(json))
      url = graphNextLink(json)
    }
    return out
  }

  private async readGoogle(token: string, from: number, to: number): Promise<RemoteEvent[]> {
    const out: RemoteEvent[] = []
    let pageToken: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const json = await this.get(googleEventsUrl(from, to, pageToken), token)
      out.push(...parseGoogleEvents(json))
      pageToken = googleNextPage(json) ?? undefined
      if (!pageToken) break
    }
    return out
  }
}
