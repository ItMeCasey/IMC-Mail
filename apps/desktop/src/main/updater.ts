import { autoUpdater } from 'electron-updater'

export type UpdateStatus =
  | { state: 'unsupported'; message: string }
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'none' }
  | { state: 'available'; version: string }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string }

/**
 * Checks GitHub Releases for a newer version and downloads it in the background. Only the
 * installed app can update itself: a development run reports that instead of trying.
 */
export class Updater {
  status: UpdateStatus

  constructor(
    private deps: { packaged: boolean; onStatus: (s: UpdateStatus) => void }
  ) {
    this.status = deps.packaged ? { state: 'idle' } : { state: 'unsupported', message: 'Updates are checked in the installed app, not in a development run.' }
    if (!deps.packaged) return
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking' }))
    autoUpdater.on('update-available', (i) => this.set({ state: 'available', version: i.version }))
    autoUpdater.on('update-not-available', () => this.set({ state: 'none' }))
    autoUpdater.on('update-downloaded', (i) => this.set({ state: 'downloaded', version: i.version }))
    autoUpdater.on('error', (e) => this.set({ state: 'error', message: e instanceof Error ? e.message : String(e) }))
  }

  private set(s: UpdateStatus): void {
    this.status = s
    this.deps.onStatus(s)
  }

  check(): void {
    if (!this.deps.packaged) return
    void autoUpdater.checkForUpdates().catch((e) => this.set({ state: 'error', message: e instanceof Error ? e.message : String(e) }))
  }

  /** Quits and installs a downloaded update. */
  install(): void {
    if (this.status.state === 'downloaded') autoUpdater.quitAndInstall()
  }
}
