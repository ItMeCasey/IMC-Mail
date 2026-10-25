import type { StreamSafeMode, StreamSafeState } from '@imc/core'

/** Programs that mean "this machine is probably streaming or recording". All lowercase. */
export const DEFAULT_WATCH = [
  'obs64.exe',
  'obs32.exe',
  'obs',
  'obs-studio',
  'streamlabs desktop.exe',
  'streamlabs obs.exe',
  'slobs.exe',
  'twitchstudio.exe',
  'xsplit.core.exe',
  'xsplit.gamecaster.exe',
  'vmix64.exe',
  'prismlivestudio.exe',
  'medal.exe',
  'lightstream.exe'
]

export interface StreamSafeSettings {
  mode: StreamSafeMode
  hideFromCapture: boolean
  watch: string[]
}

export const DEFAULT_SETTINGS: StreamSafeSettings = {
  mode: 'auto',
  hideFromCapture: true,
  watch: DEFAULT_WATCH
}

/** Process names from `tasklist /FO CSV /NH` (Windows) or `ps -A -o comm=` (macOS, Linux). */
export function parseProcessList(out: string, platform: NodeJS.Platform): string[] {
  const lines = out.split(/\r?\n/).filter(Boolean)
  if (platform === 'win32') {
    return lines.map((l) => /^"([^"]+)"/.exec(l)?.[1]?.toLowerCase()).filter((n): n is string => !!n)
  }
  return lines.map((l) => (l.trim().split('/').pop() ?? '').toLowerCase()).filter(Boolean)
}

/** The first running process that is on the watch list, or null. */
export function detectStreaming(running: string[], watch: string[]): string | null {
  const wanted = new Set(watch.map((w) => w.toLowerCase()))
  return running.find((n) => wanted.has(n)) ?? null
}

/** Whether private content should be hidden, given the mode, detection, and a hotkey override. */
export function isActive(
  mode: StreamSafeMode,
  detected: string | null,
  override: boolean | null
): boolean {
  if (override !== null) return override
  return mode === 'on' ? true : mode === 'off' ? false : detected !== null
}

/**
 * Owns the stream-safe state. It lives in the main process so the global hotkey and the process
 * watcher can change it while the app is in the background; the renderer just mirrors it.
 */
export class StreamSafeController {
  private settings: StreamSafeSettings
  private detected: string | null = null
  private override: boolean | null = null
  private timer: NodeJS.Timeout | null = null
  private last = ''

  constructor(
    private deps: {
      listProcesses: () => Promise<string[]>
      loadSettings: () => StreamSafeSettings | null
      saveSettings: (s: StreamSafeSettings) => void
      onChange: (state: StreamSafeState) => void
      pollMs?: number
    }
  ) {
    const saved = deps.loadSettings()
    this.settings = saved ? { ...DEFAULT_SETTINGS, ...saved } : { ...DEFAULT_SETTINGS }
  }

  get state(): StreamSafeState {
    return {
      active: isActive(this.settings.mode, this.detected, this.override),
      mode: this.settings.mode,
      overridden: this.override !== null,
      detected: this.detected,
      hideFromCapture: this.settings.hideFromCapture,
      watch: this.settings.watch
    }
  }

  private publish(): void {
    const s = this.state
    const key = JSON.stringify(s)
    if (key === this.last) return
    this.last = key
    this.deps.onChange(s)
  }

  /** Looks for streaming software. A change in what is running clears the hotkey override. */
  async poll(): Promise<void> {
    let found: string | null = null
    try {
      found = detectStreaming(await this.deps.listProcesses(), this.settings.watch)
    } catch {
      // Cannot list processes: keep the last answer rather than flapping.
      return
    }
    if ((found !== null) !== (this.detected !== null)) this.override = null
    this.detected = found
    this.publish()
  }

  /** What the global hotkey does: flip the current state until streaming software starts or stops. */
  toggle(): StreamSafeState {
    this.override = !this.state.active
    this.publish()
    return this.state
  }

  update(patch: Partial<StreamSafeSettings>): StreamSafeState {
    this.settings = { ...this.settings, ...patch }
    // Choosing a mode is an explicit decision; it replaces any hotkey override.
    if (patch.mode !== undefined) this.override = null
    this.deps.saveSettings(this.settings)
    // Re-evaluate detection against a changed watch list.
    void this.poll()
    this.publish()
    return this.state
  }

  start(): void {
    if (this.timer) return
    void this.poll()
    this.timer = setInterval(() => void this.poll(), this.deps.pollMs ?? 5000)
    this.publish()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
