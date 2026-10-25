import { describe, expect, it } from 'vitest'
import { resolveTheme } from './theme'
import { tapeColor } from './tape'

describe('resolveTheme', () => {
  it('prefers a stored valid choice', () => {
    expect(resolveTheme('mid', true)).toBe('mid')
    expect(resolveTheme('light', false)).toBe('light')
  })
  it('falls back to the OS preference when nothing valid is stored', () => {
    expect(resolveTheme(null, true)).toBe('light')
    expect(resolveTheme('neon', false)).toBe('dark')
  })
})

describe('tapeColor', () => {
  it('maps stored hex onto theme tokens and passes unknown colors through', () => {
    expect(tapeColor('#6366F1')).toBe('var(--tape-1)')
    expect(tapeColor('#84cc16')).toBe('var(--tape-8)')
    expect(tapeColor('#123456')).toBe('#123456')
    expect(tapeColor(undefined)).toBe('var(--ink-3)')
  })
})
