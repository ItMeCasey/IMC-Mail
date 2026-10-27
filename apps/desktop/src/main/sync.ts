import QRCode from 'qrcode'
import { SyncClient, type Pairing, type SyncAdapter, type SyncSecrets, type SyncStorage } from '@imc/core'

/** How often this computer checks for changes from other devices, and how soon after a change here it sends them. */
const EVERY_MS = 3 * 60_000
const SOON_MS = 4_000
const FIRST_MS = 20_000

/**
 * Keeps this computer's settings in step with the other devices: on a timer, a few seconds after
 * something changed here, and on request. The sync logic itself is in `SyncClient` (shared with the phone).
 */
export class DeviceSync {
  readonly client: SyncClient
  private timer: NodeJS.Timeout | null = null
  private soon: NodeJS.Timeout | null = null

  constructor(d: { storage: SyncStorage; secrets: SyncSecrets; adapters: SyncAdapter[]; onApplied: () => void; fetchFn?: typeof fetch }) {
    this.client = new SyncClient({ storage: d.storage, secrets: d.secrets, adapters: d.adapters, onApplied: d.onApplied, ...(d.fetchFn ? { fetchFn: d.fetchFn } : {}) })
  }

  start(): void {
    this.stop()
    const first = setTimeout(() => void this.client.syncNow(), FIRST_MS)
    first.unref?.()
    this.timer = setInterval(() => void this.client.syncNow(), EVERY_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.soon) clearTimeout(this.soon)
    this.timer = null
    this.soon = null
  }

  /** Something changed here: send it in a few seconds, once, however many changes come together. */
  syncSoon(): void {
    if (!this.client.status().paired || this.soon) return
    this.soon = setTimeout(() => {
      this.soon = null
      void this.client.syncNow()
    }, SOON_MS)
    this.soon.unref?.()
  }

  /** The code to show or type, and the same code as a QR image to scan. It holds the key, so it is made only when asked for. */
  async view(p: Pairing): Promise<{ code: string; qr: string }> {
    const code = this.client.pairingCode(p)
    const qr = await QRCode.toDataURL(code, { errorCorrectionLevel: 'M', margin: 2, width: 300 })
    return { code, qr }
  }
}
