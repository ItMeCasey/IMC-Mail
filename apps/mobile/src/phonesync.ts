import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'
import { SyncClient, type SyncSecrets, type SyncStatus } from '@imc/core'
import { phoneAdapters, syncStorage } from '@imc/mail'
import { db } from './db'
import { notifyChanged } from './changes'
import { rescheduleReminders } from './notify'

// This phone's side of device sync. The protocol and the encryption are in @imc/core; the phone supplies where its
// bookkeeping lives (SQLite), where the keys live (the Android keystore, through SecureStore), and what to do after
// something arrives.

export const DEFAULT_SERVER = 'https://sync.itmecasey.com'

const secrets: SyncSecrets = {
  get: async (k) => (await SecureStore.getItemAsync(k)) ?? undefined,
  set: (k, v) => SecureStore.setItemAsync(k, v),
  delete: (k) => SecureStore.deleteItemAsync(k)
}

export const sync = new SyncClient({
  storage: syncStorage(db),
  secrets,
  adapters: phoneAdapters(db),
  onApplied: () => {
    notifyChanged()
    void rescheduleReminders().catch(() => undefined)
  }
})

export const deviceName = (): string => `Android ${(Platform.constants as { Model?: string }).Model ?? 'phone'}`

const SYNC_EVERY_MS = 3 * 60_000
let timer: ReturnType<typeof setInterval> | null = null
const watchers = new Set<(s: SyncStatus) => void>()

export function watchSync(fn: (s: SyncStatus) => void): () => void {
  watchers.add(fn)
  return () => void watchers.delete(fn)
}

/** One round, telling anyone watching how it went. Never throws: a failure is in the status. */
export async function syncNow(): Promise<SyncStatus> {
  const running = sync.syncNow()
  for (const w of watchers) w(sync.status())
  const status = await running
  for (const w of watchers) w(status)
  return status
}

/** Syncs now and every few minutes while the app is open. Safe to call twice. */
export function startSyncLoop(): () => void {
  if (!timer) {
    void syncNow()
    timer = setInterval(() => void syncNow(), SYNC_EVERY_MS)
  }
  return () => {
    if (timer) clearInterval(timer)
    timer = null
  }
}

/** Reads a pairing code (pasted or scanned) and joins that group, then pulls everything in. */
export async function pair(code: string): Promise<SyncStatus> {
  await sync.join(code.trim(), deviceName())
  notifyChanged()
  return syncNow()
}

export async function unpair(): Promise<void> {
  await sync.disable()
  notifyChanged()
}
