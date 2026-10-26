import { describe, expect, it } from 'vitest'
import { escapeHtml, safeWebUrl } from './url'

describe('safeWebUrl', () => {
  it('keeps ordinary http and https addresses', () => {
    expect(safeWebUrl('https://meet.example.com/j/123?pwd=abc')).toBe('https://meet.example.com/j/123?pwd=abc')
    expect(safeWebUrl('  http://example.com ')).toBe('http://example.com')
  })

  it('rejects other schemes', () => {
    for (const u of ['javascript:alert(1)', 'file:///C:/x', 'ftp://x.example/a', 'mailto:a@b.c', 'data:text/html,hi', '//evil.example/a'])
      expect(safeWebUrl(u), u).toBeNull()
  })

  it('rejects anything that could break out of an attribute or a calendar line', () => {
    for (const u of [
      'https://x.example/"onmouseover="alert(1)',
      "https://x.example/'a",
      'https://x.example/<b>',
      'https://x.example/a b',
      'https://x.example/a\r\nATTENDEE:mailto:evil@x.example',
      'https://x.example/a\\b'
    ])
      expect(safeWebUrl(u), JSON.stringify(u)).toBeNull()
  })

  it('rejects empty, missing and oversized values', () => {
    expect(safeWebUrl(null)).toBeNull()
    expect(safeWebUrl('')).toBeNull()
    expect(safeWebUrl('https://x.example/' + 'a'.repeat(2000))).toBeNull()
  })
})

describe('escapeHtml', () => {
  it('escapes both kinds of quote so the result is safe inside an attribute', () => {
    expect(escapeHtml(`a"b'c<d>&`)).toBe('a&quot;b&#39;c&lt;d&gt;&amp;')
  })
})
