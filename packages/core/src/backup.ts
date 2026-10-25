import { z } from 'zod'
import { categorySchema, notificationSettingsSchema } from './schemas'

/**
 * A file of your own settings you can move to another computer: labels, rules, saved searches,
 * reply templates (text only), notification choices. Never accounts, passwords or mail.
 */
export const backupSchema = z.object({
  app: z.literal('IMC-Mail'),
  version: z.literal(1),
  exportedAt: z.number(),
  labels: z.array(z.string().trim().min(1).max(40)).max(500).default([]),
  rules: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(60),
        enabled: z.boolean().default(true),
        match: z.object({
          from: z.string().max(200).default(''),
          to: z.string().max(200).default(''),
          subject: z.string().max(200).default(''),
          contains: z.string().max(200).default('')
        }),
        actions: z.object({
          /** By name, because label ids differ between computers. */
          labelName: z.string().max(40).nullable().default(null),
          category: categorySchema.nullable().default(null),
          markRead: z.boolean().default(false),
          star: z.boolean().default(false),
          archive: z.boolean().default(false)
        })
      })
    )
    .max(500)
    .default([]),
  savedSearches: z.array(z.object({ name: z.string().trim().min(1).max(60), query: z.string().trim().min(1).max(500) })).max(500).default([]),
  templates: z.array(z.object({ name: z.string().trim().min(1).max(80), subject: z.string().max(998), html: z.string().max(200_000) })).max(500).default([]),
  notifications: notificationSettingsSchema.optional(),
  closeToTray: z.boolean().optional()
})
export type Backup = z.infer<typeof backupSchema>

/** Parses the text of a backup file, saying plainly why it cannot be used. */
export function parseBackup(text: string): { ok: true; backup: Backup } | { ok: false; error: string } {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, error: 'That file is not a settings backup (it is not valid JSON).' }
  }
  const r = backupSchema.safeParse(json)
  if (r.success) return { ok: true, backup: r.data }
  const app = (json as { app?: unknown } | null)?.app
  if (app !== 'IMC-Mail') return { ok: false, error: 'That file was not made by IMC-Mail.' }
  return { ok: false, error: 'That backup is damaged or from a newer version of IMC-Mail.' }
}

export interface ImportPlan {
  labels: string[]
  rules: Backup['rules']
  savedSearches: Backup['savedSearches']
  templates: Backup['templates']
  skipped: number
}

/**
 * What an import would add: everything in the backup that you do not already have. Matching is by
 * name (labels, rules, templates, ignoring case) or by query (saved searches), so importing the
 * same file twice changes nothing.
 */
export function planImport(
  have: { labels: string[]; rules: string[]; savedSearchQueries: string[]; templates: string[] },
  backup: Backup
): ImportPlan {
  const lower = (xs: string[]) => new Set(xs.map((x) => x.toLowerCase()))
  const labels = lower(have.labels)
  const rules = lower(have.rules)
  const queries = new Set(have.savedSearchQueries.map((q) => q.trim()))
  const templates = lower(have.templates)
  let skipped = 0
  const keep = <T>(items: T[], key: (t: T) => string, seen: Set<string>, fold = true): T[] =>
    items.filter((t) => {
      const k = fold ? key(t).toLowerCase() : key(t)
      if (seen.has(k)) {
        skipped++
        return false
      }
      seen.add(k)
      return true
    })
  return {
    labels: keep(backup.labels, (l) => l, labels),
    rules: keep(backup.rules, (r) => r.name, rules),
    savedSearches: keep(backup.savedSearches, (s) => s.query.trim(), queries, false),
    templates: keep(backup.templates, (t) => t.name, templates),
    skipped
  }
}
