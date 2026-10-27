import { describe, expect, it } from 'vitest'
import { attachPathsFromArgs, mailtoFromArgs, parseMailto } from './mailto'

describe('parseMailto', () => {
  it('reads a plain address', () => {
    expect(parseMailto('mailto:pat@brand.example')).toEqual({ to: ['pat@brand.example'], cc: [], bcc: [], subject: '', body: '' })
  })

  it('reads subject, body, cc and bcc, with percent-encoding', () => {
    const d = parseMailto('mailto:a@x.example?subject=Hello%20there%21&body=Line%20one%0D%0ALine%20two&cc=c@x.example&bcc=b@x.example')
    expect(d).toEqual({ to: ['a@x.example'], cc: ['c@x.example'], bcc: ['b@x.example'], subject: 'Hello there!', body: 'Line one\nLine two' })
  })

  it('takes several addresses from the path and from a to field, once each', () => {
    const d = parseMailto('mailto:a@x.example,b@x.example?to=b@x.example;c@x.example&cc=d@x.example,e@x.example')
    expect(d?.to).toEqual(['a@x.example', 'b@x.example', 'c@x.example'])
    expect(d?.cc).toEqual(['d@x.example', 'e@x.example'])
  })

  it('handles a link with only a subject or body, and encoded addresses', () => {
    expect(parseMailto('mailto:?subject=Feedback')).toMatchObject({ to: [], subject: 'Feedback' })
    expect(parseMailto('mailto:name%40x.example')?.to).toEqual(['name@x.example'])
    expect(parseMailto('MAILTO:a@x.example')?.to).toEqual(['a@x.example'])
    expect(parseMailto('mailto://a@x.example')?.to).toEqual(['a@x.example'])
  })

  it('reads unicode and keeps a plus sign as a plus', () => {
    const d = parseMailto('mailto:a@x.example?subject=Caf%C3%A9%20%E2%9C%93&body=1%2B1')
    expect(d?.subject).toBe('Café ✓')
    expect(d?.body).toBe('1+1')
  })

  it('takes the address out of "Name <a@b>" and drops things that are not addresses', () => {
    expect(parseMailto('mailto:Pat%20Lee%20%3Cpat@x.example%3E,not-an-address,javascript:alert(1)')?.to).toEqual(['pat@x.example'])
  })

  it('cannot add a header through the subject', () => {
    const d = parseMailto('mailto:a@x.example?subject=Hi%0D%0ABcc:%20evil@x.example')
    expect(d?.subject).toBe('Hi Bcc: evil@x.example')
    expect(d?.subject).not.toMatch(/[\r\n]/)
    expect(d?.bcc).toEqual([])
  })

  it('ignores attach and other fields it does not know', () => {
    const d = parseMailto('mailto:a@x.example?attach=C:%5CUsers%5Csecret.txt&in-reply-to=%3Cx%40y%3E&x-custom=1&subject=ok')
    expect(d).toEqual({ to: ['a@x.example'], cc: [], bcc: [], subject: 'ok', body: '' })
  })

  it('survives a stray percent sign and a bad pair', () => {
    expect(parseMailto('mailto:a@x.example?subject=100%&body=%E0%A4%A&&=x&cc')?.subject).toBe('100%')
  })

  it('caps lengths', () => {
    const many = Array.from({ length: 80 }, (_, i) => `u${i}@x.example`).join(',')
    expect(parseMailto(`mailto:${many}`)?.to).toHaveLength(50)
    expect(parseMailto(`mailto:a@x.example?subject=${'a'.repeat(1000)}`)?.subject).toHaveLength(300)
    expect(parseMailto(`mailto:a@x.example?body=${'b'.repeat(100_000)}`)?.body).toHaveLength(50_000)
  })

  it('says no to anything that is not a mailto link, and to an empty one', () => {
    expect(parseMailto('https://x.example')).toBeNull()
    expect(parseMailto('')).toBeNull()
    expect(parseMailto('mailto:')).toBeNull()
    expect(parseMailto('mailto:?')).toBeNull()
  })
})

describe('mailtoFromArgs', () => {
  it('finds the link among the arguments Windows passes', () => {
    expect(mailtoFromArgs(['C:\\app\\IMC-Mail.exe', '--flag', 'mailto:a@x.example?subject=Hi'])).toBe('mailto:a@x.example?subject=Hi')
    expect(mailtoFromArgs(['C:\\app\\IMC-Mail.exe'])).toBeNull()
  })
})

describe('attachPathsFromArgs', () => {
  it('collects each file given with --attach, in order', () => {
    expect(attachPathsFromArgs(['IMC-Mail.exe', '--attach', 'C:\\a b\\one.pdf', '--attach', 'C:\\two.png'])).toEqual(['C:\\a b\\one.pdf', 'C:\\two.png'])
  })

  it('skips a missing path, a flag in its place, and arguments that are not --attach', () => {
    expect(attachPathsFromArgs(['x.exe', '--attach'])).toEqual([])
    expect(attachPathsFromArgs(['x.exe', '--attach', '--other', 'C:\\f.txt'])).toEqual([])
    expect(attachPathsFromArgs(['x.exe', '--attach', ' ', 'C:\\f.txt'])).toEqual([])
    expect(attachPathsFromArgs(['x.exe', 'C:\\f.txt'])).toEqual([])
  })
})
