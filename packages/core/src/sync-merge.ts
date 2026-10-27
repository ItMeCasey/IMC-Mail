import { z } from 'zod'
import { compareHlc, isHlc, isPlausibleHlc } from './sync-clock'

/** The kinds of thing that sync between devices. Mail itself never does. */
export const syncTypes = [
  'label',
  'rule',
  'savedSearch',
  'template',
  'deal',
  /** A label on one message, keyed by account and Message-ID. */
  'messageLabel',
  'snooze',
  'followUp',
  'meeting',
  'pref',
  /** An account's display name, so another device can say "sign in to add this account". */
  'accountName'
] as const
export type SyncType = (typeof syncTypes)[number]

/** Most a sealed record may weigh, as base64 text. Records are small settings, not files. */
export const MAX_PAYLOAD_CHARS = 65_536

/** One synced item as the server and the other devices see it: an envelope around an encrypted payload. */
export const syncRecordSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.enum(syncTypes),
  hlc: z.string().refine(isHlc, 'Not a clock stamp'),
  deleted: z.boolean(),
  payload: z.string().max(MAX_PAYLOAD_CHARS)
})
export type SyncRecord = z.infer<typeof syncRecordSchema>

export const recordKey = (r: Pick<SyncRecord, 'type' | 'id'>): string => `${r.type}:${r.id}`

/** The record that stands: the newer clock wins, and a deletion is just a record like any other. */
export function newer(a: SyncRecord, b: SyncRecord): SyncRecord {
  return compareHlc(b.hlc, a.hlc) > 0 ? b : a
}

/**
 * Merges records that arrived from elsewhere into what this device has. Returns the ones that changed
 * something here, and how many were refused for carrying an impossible clock. Applying the same records
 * in any order, or twice, ends in the same state.
 */
export function mergeIncoming(
  have: Map<string, SyncRecord>,
  incoming: SyncRecord[],
  now: number
): { applied: SyncRecord[]; refused: number } {
  const applied: SyncRecord[] = []
  let refused = 0
  for (const r of incoming) {
    if (!isPlausibleHlc(r.hlc, now)) {
      refused++
      continue
    }
    const key = recordKey(r)
    const mine = have.get(key)
    if (mine && newer(mine, r) === mine) continue
    have.set(key, r)
    applied.push(r)
  }
  return { applied, refused }
}
