import { describe, expect, it } from 'vitest'
import {
  computeThreads,
  isReplySubject,
  normalizeSubject,
  parseMessageIds,
  type ThreadInput
} from './threading'

const m = (
  id: string,
  messageId: string | null,
  refs: string[],
  subject: string,
  date: number
): ThreadInput => ({ id, messageId, refs, subject, date })

describe('subjects', () => {
  it('strips reply and forward prefixes in several languages', () => {
    expect(normalizeSubject('Re: RE: Fwd:  Hello   World')).toBe('hello world')
    expect(normalizeSubject('AW: Angebot')).toBe('angebot')
    expect(normalizeSubject('Re[2]: x')).toBe('x')
    expect(isReplySubject('Re: x')).toBe(true)
    expect(isReplySubject('Reminder: x')).toBe(false)
  })
})

describe('parseMessageIds', () => {
  it('reads every id from a References header', () => {
    expect(parseMessageIds('<a@x>\r\n <b@y> junk <c@z>')).toEqual(['<a@x>', '<b@y>', '<c@z>'])
    expect(parseMessageIds('')).toEqual([])
  })
})

describe('computeThreads', () => {
  it('links a reply chain and keys the thread by its oldest message', () => {
    const t = computeThreads([
      m('3', '<c>', ['<a>', '<b>'], 'Re: Deal', 300),
      m('1', '<a>', [], 'Deal', 100),
      m('2', '<b>', ['<a>'], 'Re: Deal', 200)
    ])
    expect(new Set(t.values())).toEqual(new Set(['1']))
  })

  it('joins siblings through an ancestor we never downloaded', () => {
    const t = computeThreads([
      m('1', '<r1>', ['<ghost>'], 'Re: Q', 100),
      m('2', '<r2>', ['<ghost>'], 'Re: Q', 200)
    ])
    expect(t.get('1')).toBe(t.get('2'))
  })

  it('keeps unrelated messages with the same subject apart', () => {
    const t = computeThreads([
      m('1', '<a>', [], 'Your receipt', 100),
      m('2', '<b>', [], 'Your receipt', 200)
    ])
    expect(t.get('1')).not.toBe(t.get('2'))
  })

  it('attaches a reference-less reply to its single original by subject', () => {
    const t = computeThreads([
      m('1', '<a>', [], 'Collab?', 100),
      m('2', '<b>', [], 'Re: Collab?', 200)
    ])
    expect(t.get('2')).toBe('1')
  })

  it('does not guess when the subject is ambiguous or the original is too old', () => {
    const ambiguous = computeThreads([
      m('1', '<a>', [], 'Hi', 100),
      m('2', '<b>', [], 'Hi', 150),
      m('3', '<c>', [], 'Re: Hi', 200)
    ])
    expect(ambiguous.get('3')).toBe('3')
    const old = computeThreads([
      m('1', '<a>', [], 'Hi', 0),
      m('2', '<b>', [], 'Re: Hi', 90 * 24 * 3600 * 1000)
    ])
    expect(old.get('2')).toBe('2')
  })

  it('handles messages with no Message-ID', () => {
    const t = computeThreads([m('1', null, [], 'a', 1), m('2', null, [], 'b', 2)])
    expect(t.get('1')).toBe('1')
    expect(t.get('2')).toBe('2')
  })
})
