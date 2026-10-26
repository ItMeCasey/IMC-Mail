import { describe, expect, it, vi } from 'vitest'
import type { StreamSafeState } from '@imc/core'
import {
  DEFAULT_SETTINGS,
  detectStreaming,
  isActive,
  parseProcessList,
  StreamSafeController,
  type StreamSafeSettings
} from './streamsafe'

describe('parseProcessList', () => {
  it('reads Windows tasklist CSV', () => {
    const out = '"System","4","Services","0","12 K"\r\n"obs64.exe","9120","Console","1","220,000 K"\r\n'
    expect(parseProcessList(out, 'win32')).toEqual(['system', 'obs64.exe'])
  })
  it('reads ps output, keeping only the program name', () => {
    expect(parseProcessList('/usr/bin/zsh\n/Applications/OBS.app/Contents/MacOS/obs\n', 'darwin')).toEqual(['zsh', 'obs'])
  })
})

describe('detectStreaming / isActive', () => {
  it('matches case-insensitively against the watch list', () => {
    expect(detectStreaming(['chrome.exe', 'obs64.exe'], ['OBS64.EXE'])).toBe('obs64.exe')
    expect(detectStreaming(['chrome.exe'], ['obs64.exe'])).toBeNull()
  })
  it('on and off ignore detection; auto follows it; an override beats all', () => {
    expect(isActive('on', null, null)).toBe(true)
    expect(isActive('off', 'obs64.exe', null)).toBe(false)
    expect(isActive('auto', 'obs64.exe', null)).toBe(true)
    expect(isActive('auto', null, null)).toBe(false)
    expect(isActive('auto', 'obs64.exe', false)).toBe(false)
    expect(isActive('off', null, true)).toBe(true)
  })
})

function make(initial: Partial<StreamSafeSettings> | null = null) {
  let running: string[] = []
  let saved: StreamSafeSettings | null = initial ? { ...DEFAULT_SETTINGS, ...initial } : null
  const states: StreamSafeState[] = []
  const c = new StreamSafeController({
    listProcesses: async () => running,
    loadSettings: () => saved,
    saveSettings: (s) => (saved = s),
    onChange: (s) => states.push(s)
  })
  return { c, states, setRunning: (r: string[]) => (running = r), saved: () => saved }
}

describe('StreamSafeController', () => {
  it('defaults to auto: off until streaming software appears, off again when it closes', async () => {
    const t = make()
    await t.c.poll()
    expect(t.c.state).toMatchObject({ active: false, mode: 'auto', detected: null })
    t.setRunning(['obs64.exe'])
    await t.c.poll()
    expect(t.c.state).toMatchObject({ active: true, detected: 'obs64.exe' })
    t.setRunning([])
    await t.c.poll()
    expect(t.c.state.active).toBe(false)
  })

  it('the hotkey flips the state until streaming software starts or stops', async () => {
    const t = make()
    t.setRunning(['obs64.exe'])
    await t.c.poll()
    expect(t.c.toggle()).toMatchObject({ active: false, overridden: true })
    await t.c.poll() // OBS still running: override holds
    expect(t.c.state.active).toBe(false)
    t.setRunning([])
    await t.c.poll() // OBS closed: back to automatic
    expect(t.c.state).toMatchObject({ active: false, overridden: false })
    t.setRunning(['obs64.exe'])
    await t.c.poll() // next stream starts protected again
    expect(t.c.state.active).toBe(true)
  })

  it('toggling when idle turns protection on', () => {
    const t = make()
    expect(t.c.toggle()).toMatchObject({ active: true, overridden: true })
  })

  it('choosing a mode persists it and replaces the override', () => {
    const t = make()
    t.c.toggle()
    const s = t.c.update({ mode: 'on' })
    expect(s).toMatchObject({ mode: 'on', active: true, overridden: false })
    expect(t.saved()?.mode).toBe('on')
    expect(t.c.update({ mode: 'off' }).active).toBe(false)
  })

  it('loads saved settings and fills in anything missing', () => {
    const t = make({ mode: 'on', hideFromCapture: false })
    expect(t.c.state).toMatchObject({ mode: 'on', active: true, hideFromCapture: false })
    expect(t.c.state.watch).toContain('obs64.exe')
  })

  it('a custom watch list is honoured', async () => {
    const t = make()
    t.c.update({ watch: ['mystream.exe'] })
    t.setRunning(['mystream.exe'])
    await t.c.poll()
    expect(t.c.state.active).toBe(true)
  })

  it('switched off, it is never active, ignores the hotkey, and stops watching', async () => {
    const t = make({ mode: 'on' })
    expect(t.c.state.active).toBe(true)
    t.c.setEnabled(false)
    expect(t.c.state.active).toBe(false)
    expect(t.c.toggle().active).toBe(false)
    t.setRunning(['obs64.exe'])
    await t.c.poll()
    expect(t.c.state.detected).toBeNull()
    t.c.setEnabled(true)
    expect(t.c.state.active).toBe(true)
    t.c.stop()
  })

  it('keeps its last answer when the process list cannot be read', async () => {
    const onChange = vi.fn()
    let fail = false
    const c = new StreamSafeController({
      listProcesses: async () => {
        if (fail) throw new Error('tasklist failed')
        return ['obs64.exe']
      },
      loadSettings: () => null,
      saveSettings: () => {},
      onChange
    })
    await c.poll()
    fail = true
    await c.poll()
    expect(c.state.active).toBe(true)
  })

  it('only publishes real changes', async () => {
    const t = make()
    await t.c.poll()
    await t.c.poll()
    await t.c.poll()
    expect(t.states.length).toBe(1)
  })
})
