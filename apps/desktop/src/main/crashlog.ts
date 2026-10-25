import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { scrub, type CrashEntry } from '@imc/core'

const KEEP = 20

/**
 * The last few errors this app hit, kept in a small file on this computer. Nothing is sent
 * anywhere: they only go into a report if you choose to make one. Text is scrubbed on the way in.
 */
export class CrashLog {
  constructor(
    private file: string,
    private now: () => number = Date.now
  ) {}

  list(): CrashEntry[] {
    try {
      if (!existsSync(this.file)) return []
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      return Array.isArray(data) ? (data as CrashEntry[]) : []
    } catch {
      return []
    }
  }

  add(kind: CrashEntry['kind'], error: unknown): void {
    const e = error as { message?: unknown; stack?: unknown } | null
    const message = typeof e?.message === 'string' ? e.message : typeof error === 'string' ? error : JSON.stringify(error) ?? 'unknown error'
    const stack = typeof e?.stack === 'string' ? e.stack : undefined
    const entry: CrashEntry = { at: this.now(), kind, message: scrub(message).slice(0, 500), ...(stack ? { stack: scrub(stack).split('\n').slice(0, 12).join('\n') } : {}) }
    try {
      writeFileSync(this.file, JSON.stringify([...this.list(), entry].slice(-KEEP), null, 2))
    } catch {
      /* a log that cannot be written must never become another crash */
    }
  }
}
