import { describe, expect, it } from 'vitest'
import { isAllowedRelayUrl, issueUrl, reportBody, scrub, type CrashEntry } from './report'

describe('scrub', () => {
  it('removes addresses, Windows and Unix user names, and token-like strings', () => {
    expect(scrub('failed for casey@example.com')).toBe('failed for <email>')
    expect(scrub('at C:\\Users\\casey\\Desktop\\IMC-Mail\\out\\main\\index.js:10')).toBe('at C:\\Users\\<user>\\Desktop\\IMC-Mail\\out\\main\\index.js:10')
    expect(scrub('/Users/casey/app/x.js and /home/casey/y.js')).toBe('/Users/<user>/app/x.js and /home/<user>/y.js')
    expect(scrub('token ya29.A0ARrdaM-9wYqLQ8abcdefghijklmnopqrstuv end')).toContain('<token>')
    expect(scrub('Authorization: Bearer abcdefgh12345678')).toContain('<token>')
  })
  it('also catches paths whose backslashes were doubled by JSON', () => {
    expect(scrub(String.raw`at C:\\Users\\casey\\a.js`)).toBe(String.raw`at C:\\Users\\<user>\\a.js`)
  })
  it('leaves ordinary text alone', () => {
    expect(scrub('Cannot read properties of undefined (reading "id")')).toBe('Cannot read properties of undefined (reading "id")')
  })
})

describe('reportBody', () => {
  const crash: CrashEntry = { at: Date.UTC(2026, 9, 25, 12), kind: 'error', message: 'boom for me@x.example', stack: 'Error: boom\n at C:\\Users\\casey\\a.js:1' }
  it('has the version, a prompt when no note was written, and scrubbed errors', () => {
    const b = reportBody({ version: '1.2.3', platform: 'win32', crashes: [crash] })
    expect(b).toContain('Version: 1.2.3')
    expect(b).toContain('please describe')
    expect(b).toContain('Uncaught error: boom for <email>')
    expect(b).toContain('C:\\Users\\<user>\\a.js')
    expect(b).not.toContain('casey')
    expect(b).not.toContain('me@x.example')
  })
  it('uses the note you wrote, scrubbed too, and omits the errors section when there are none', () => {
    const b = reportBody({ version: '1', platform: 'win32', note: 'Sync stops for bob@y.example', crashes: [] })
    expect(b).toContain('Sync stops for <email>')
    expect(b).not.toContain('Recent errors')
  })
})

describe('issueUrl', () => {
  it('points at the new-issue page with the title and body encoded', () => {
    const u = new URL(issueUrl('Crash: boom', 'line one\nline two'))
    expect(u.origin + u.pathname).toBe('https://github.com/ItMeCasey/IMC-Mail/issues/new')
    expect(u.searchParams.get('title')).toBe('Crash: boom')
    expect(u.searchParams.get('body')).toBe('line one\nline two')
    expect(u.searchParams.get('labels')).toBe('bug')
  })
  it('shortens a very long report to fit a link, and says so', () => {
    const body = Array.from({ length: 400 }, (_, i) => `- line ${i} with some words to make it long`).join('\n')
    const url = issueUrl('t', body)
    expect(url.length).toBeLessThanOrEqual(7000)
    expect(new URL(url).searchParams.get('body')).toContain('shortened')
  })
})

describe('isAllowedRelayUrl', () => {
  it('accepts https, and http only for this computer', () => {
    expect(isAllowedRelayUrl('https://itmecasey.example/imc/report')).toBe(true)
    expect(isAllowedRelayUrl('http://127.0.0.1:8787/report')).toBe(true)
    expect(isAllowedRelayUrl('http://localhost:8787/report')).toBe(true)
  })
  it('refuses plain http elsewhere, other schemes and junk', () => {
    expect(isAllowedRelayUrl('http://example.com/report')).toBe(false)
    expect(isAllowedRelayUrl('file:///etc/passwd')).toBe(false)
    expect(isAllowedRelayUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedRelayUrl('not a url')).toBe(false)
    expect(isAllowedRelayUrl('')).toBe(false)
  })
})
