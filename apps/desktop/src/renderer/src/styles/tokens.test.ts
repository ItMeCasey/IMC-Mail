import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(__dirname, 'tokens.css'), 'utf8')

/** Collects `--name: #hex` pairs from every block whose selector matches the theme. */
function theme(name: 'dark' | 'mid' | 'light'): Record<string, string> {
  const out: Record<string, string> = {}
  const blocks = css.matchAll(/([^{}]+)\{([^{}]*)\}/g)
  for (const [, selector, body] of blocks) {
    const sel = selector!.trim()
    const applies =
      name === 'dark'
        ? /^:root(,\s*:root\[data-theme='dark'\])?$/.test(sel.replace(/\s+/g, ' ')) ||
          sel.includes("data-theme='dark'")
        : sel.includes(`data-theme='${name}'`)
    if (!applies) continue
    for (const m of body!.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]!] = m[2]!
  }
  return out
}

const lum = (hex: string): number => {
  const c = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
}
const ratio = (a: string, b: string): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

const surfaces = ['ground', 'rail', 'sheet', 'raised', 'hover'] as const

describe.each(['dark', 'mid', 'light'] as const)('%s theme', (name) => {
  const t = theme(name)

  it('defines the full semantic set', () => {
    for (const k of ['ground', 'rail', 'sheet', 'raised', 'hover', 'selected', 'line', 'line-strong', 'ink', 'ink-2', 'ink-3', 'accent', 'on-accent', 'alert', 'attn', 'on-attn', 'ok'])
      expect(t[k], k).toMatch(/^#/)
    for (let i = 1; i <= 8; i++) expect(t[`tape-${i}`], `tape-${i}`).toMatch(/^#/)
  })

  it.each(['ink', 'ink-2', 'ink-3'])('%s text reaches 4.5:1 on every surface', (ink) => {
    for (const s of surfaces) expect(ratio(t[ink]!, t[s]!), `${ink} on ${s}`).toBeGreaterThanOrEqual(4.5)
  })

  it('ink also reads on the selected row; ink-2 does too', () => {
    expect(ratio(t['ink']!, t['selected']!)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(t['ink-2']!, t['selected']!)).toBeGreaterThanOrEqual(4.5)
  })

  it('accent and alert read as text on sheet and rail', () => {
    for (const c of ['accent', 'alert', 'ok'])
      for (const s of ['sheet', 'rail', 'raised'])
        expect(ratio(t[c]!, t[s]!), `${c} on ${s}`).toBeGreaterThanOrEqual(4.5)
  })

  it('labels on filled accent and attention marks reach 4.5:1', () => {
    expect(ratio(t['on-accent']!, t['accent']!)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(t['on-attn']!, t['attn']!)).toBeGreaterThanOrEqual(4.5)
  })

  it('control borders (line-strong) and tape marks reach 3:1', () => {
    for (const s of ['sheet', 'rail', 'raised']) {
      expect(ratio(t['line-strong']!, t[s]!), `line-strong on ${s}`).toBeGreaterThanOrEqual(3)
      for (let i = 1; i <= 8; i++)
        expect(ratio(t[`tape-${i}`]!, t[s]!), `tape-${i} on ${s}`).toBeGreaterThanOrEqual(3)
    }
  })

  it('tape colors are distinguishable from each other', () => {
    const seen = new Set(Array.from({ length: 8 }, (_, i) => t[`tape-${i + 1}`]))
    expect(seen.size).toBe(8)
  })
})
