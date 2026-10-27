import { attachPathsFromArgs, mailtoFromArgs, parseMailto, type ComposeRequest, type DraftAttachment, type MailtoDraft } from '@imc/core'

// Messages started from outside the app. Windows starts IMC-Mail (or tells the copy that is already running) with a
// mailto: link when one is clicked, and with "--attach <file>" once for each file chosen in the right-click item
// "Mail this". Several files chosen together arrive as several launches a moment apart, so they are gathered into
// one message. The window asks for the result with take().

export interface LaunchDeps {
  /** Checks files and returns them as attachments (throws for one that is too big or not a file). */
  vet: (paths: string[]) => Promise<DraftAttachment[]>
  /** A message is waiting: bring the window forward and tell it. */
  ready: () => void
  /** Something went wrong the person should know about (a file that cannot be attached). */
  fail: (message: string) => void
  /** How long to wait for more files before opening the message. */
  gatherMs?: number
}

export class LaunchInbox {
  private mailto: MailtoDraft | null = null
  private files: string[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private waiting: ComposeRequest | null = null

  constructor(private deps: LaunchDeps) {}

  /** Looks through a launch's arguments for a mail link or files to attach. Anything else is ignored. */
  handle(argv: readonly string[]): void {
    const link = mailtoFromArgs(argv)
    const parsed = link ? parseMailto(link) : null
    const files = attachPathsFromArgs(argv)
    if (!parsed && files.length === 0) return
    if (parsed) this.mailto = parsed
    for (const f of files) if (!this.files.includes(f)) this.files.push(f)
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), this.deps.gatherMs ?? 1200)
    this.timer.unref?.()
  }

  private async flush(): Promise<void> {
    this.timer = null
    const mailto = this.mailto
    const files = this.files
    this.mailto = null
    this.files = []
    const attachments: DraftAttachment[] = []
    const problems: string[] = []
    for (const f of files) {
      try {
        attachments.push(...(await this.deps.vet([f])))
      } catch (e) {
        problems.push(e instanceof Error ? e.message : String(e))
      }
    }
    if (problems.length > 0) this.deps.fail(problems.join('\n'))
    if (!mailto && attachments.length === 0) return
    const merged: ComposeRequest = { to: mailto?.to ?? [], cc: mailto?.cc ?? [], bcc: mailto?.bcc ?? [], subject: mailto?.subject ?? '', body: mailto?.body ?? '', attachments }
    // Messages that arrive before the window has taken the last one are joined, so nothing is lost.
    this.waiting = this.waiting ? { ...merged, attachments: [...this.waiting.attachments, ...merged.attachments] } : merged
    this.deps.ready()
  }

  /** The message that is waiting, once. */
  take(): ComposeRequest | null {
    const w = this.waiting
    this.waiting = null
    return w
  }
}
