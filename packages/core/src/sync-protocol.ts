import { z } from 'zod'
import { fromB64, isDataKey, toB64 } from './sync-crypto'
import { syncRecordSchema } from './sync-merge'
import { safeWebUrl } from './url'

/** Where IMC-Mail's sync server runs. Pairing codes carry the address, so another server can be used. */
export const SYNC_SERVER_URL = 'https://sync.itmecasey.com'

/** Most records one push or one pull carries. A device with more catches up in several rounds. */
export const MAX_BATCH = 500

const id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/)
const deviceSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_]{4,32}$/),
  /** 65 raw bytes of an ECDSA P-256 public key, base64url. */
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
  /** A name to show in the list of devices, such as "Pixel 9". */
  name: z.string().max(60).default('')
})

/** The first device creates the group. It stores a hash of the join proof, not the key. */
export const createGroupRequest = z.object({ groupId: id, joinHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/), device: deviceSchema })
/** A later device joins by showing the proof, which it derives from the key in the pairing code. */
export const joinGroupRequest = z.object({ groupId: id, joinToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/), device: deviceSchema })

/** Pushes this device's changes and asks for everything the server has after `since`. */
export const syncRequest = z.object({
  since: z.number().int().min(0),
  records: z.array(syncRecordSchema).max(MAX_BATCH),
  limit: z.number().int().min(1).max(MAX_BATCH).default(MAX_BATCH)
})
export type SyncRequest = z.input<typeof syncRequest>

export const syncResponse = z.object({
  /** Records from other devices (and this one's own, harmlessly), each with the server's running number. */
  records: z.array(syncRecordSchema.extend({ seq: z.number().int().min(1) })),
  /** Ask again with this as `since`. */
  seq: z.number().int().min(0),
  /** More are waiting: ask again straight away. */
  more: z.boolean(),
  /** Records from this push the server turned away (a clock too far ahead, or the group is full). */
  refused: z.number().int().min(0).default(0)
})
export type SyncResponse = z.infer<typeof syncResponse>

// ---- signed requests -------------------------------------------------------------------------------------

/** How far a request's timestamp may be from the server's clock. Limits how long a captured request can be replayed. */
export const MAX_REQUEST_SKEW_MS = 5 * 60 * 1000

/** The exact text a device signs: what it asks for, when, and a hash of the body. */
export const canonicalRequest = (r: { method: string; path: string; timestamp: number; bodyHash: string }): string =>
  `imc-sync1\n${r.method.toUpperCase()}\n${r.path}\n${r.timestamp}\n${r.bodyHash}`

export interface Auth {
  groupId: string
  deviceId: string
  timestamp: number
  signature: string
}

export const formatAuth = (a: Auth): string => `IMC-Sig g=${a.groupId},d=${a.deviceId},t=${a.timestamp},s=${a.signature}`

export function parseAuth(header: string | undefined): Auth | null {
  const m = /^IMC-Sig g=([A-Za-z0-9_-]{8,64}),d=([A-Za-z0-9_]{4,32}),t=(\d{10,16}),s=([A-Za-z0-9_-]{86})$/.exec(header ?? '')
  return m ? { groupId: m[1]!, deviceId: m[2]!, timestamp: Number(m[3]), signature: m[4]! } : null
}

// ---- pairing code ----------------------------------------------------------------------------------------

const PREFIX = 'imcsync1:'

export interface Pairing {
  /** Where the sync server is, always https. */
  server: string
  groupId: string
  /** The group's data key. Anyone holding this code can read and write the synced data. */
  key: string
}

/**
 * The text behind the QR code on desktop, and the recovery code you can keep. It holds the key, so it
 * is shown only on request and is never sent to the server.
 */
export function encodePairing(p: Pairing): string {
  return PREFIX + toB64(new TextEncoder().encode(JSON.stringify({ v: 1, s: p.server, g: p.groupId, k: p.key })))
}

/** Reads a pairing code, or returns null if it is not one, or is damaged, or points anywhere but an https server. */
export function decodePairing(text: string): Pairing | null {
  const t = text.trim().replace(/\s+/g, '')
  if (!t.startsWith(PREFIX)) return null
  try {
    const j = JSON.parse(new TextDecoder().decode(fromB64(t.slice(PREFIX.length)))) as { v?: unknown; s?: unknown; g?: unknown; k?: unknown }
    if (j.v !== 1 || typeof j.s !== 'string' || typeof j.g !== 'string' || typeof j.k !== 'string') return null
    const server = safeWebUrl(j.s)
    if (!server || !server.startsWith('https://') || !id.safeParse(j.g).success || !isDataKey(j.k)) return null
    return { server: server.replace(/\/+$/, ''), groupId: j.g, key: j.k }
  } catch {
    return null
  }
}
