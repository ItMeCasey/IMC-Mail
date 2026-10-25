/** Brings snoozed mail back on time, including mail that came due while the app was closed. */
export class SnoozeWaker {
  private timer: NodeJS.Timeout | null = null

  constructor(
    private deps: {
      /** Removes snoozes that are due and returns the message ids. */
      wakeDue: (now: number) => string[]
      /** Makes a woken message unread again (locally for sure, on the server if reachable). */
      markUnread: (id: string) => Promise<void>
      onWoken: (ids: string[]) => void
      now?: () => number
      intervalMs?: number
    }
  ) {}

  async tick(): Promise<string[]> {
    const ids = this.deps.wakeDue((this.deps.now ?? Date.now)())
    for (const id of ids) {
      try {
        await this.deps.markUnread(id)
      } catch {
        /* the message still returns; only the unread flag could not be set on the server */
      }
    }
    if (ids.length > 0) this.deps.onWoken(ids)
    return ids
  }

  start(): void {
    if (this.timer) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? 30_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
