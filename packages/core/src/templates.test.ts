import { describe, expect, it } from 'vitest'
import { brandFrom, fillTemplate, hasPlaceholders, parseRecipient, placeholdersIn, variableValues } from './templates'

const NOW = new Date(2026, 9, 25, 10, 0) // Sunday

describe('parseRecipient', () => {
  it('splits names and addresses', () => {
    expect(parseRecipient('Pat Lee <pat@brand.example>')).toEqual({ name: 'Pat Lee', address: 'pat@brand.example' })
    expect(parseRecipient('"Lee, Pat" <pat@brand.example>')).toEqual({ name: 'Lee, Pat', address: 'pat@brand.example' })
    expect(parseRecipient('pat@brand.example')).toEqual({ name: '', address: 'pat@brand.example' })
  })
})

describe('brandFrom', () => {
  it('prefers a clean display name, then the domain', () => {
    expect(brandFrom('Nova Energy (demo)', 'p@nova.example')).toBe('Nova Energy')
    expect(brandFrom('', 'p@orbit-peripherals.example')).toBe('Orbit-peripherals')
    expect(brandFrom('p@nova.example', 'p@nova.example')).toBe('Nova')
  })
})

describe('fillTemplate', () => {
  const vars = { recipient: 'Pat Lee <pat@nova-energy.example>', myName: 'Casey', myEmail: 'c@me.example', subject: 'Q4 brief', now: NOW }

  it('fills known variables, case- and space-insensitively', () => {
    const r = fillTemplate('Hi {{first_name}}, thanks for {{ Brand }}! — {{MY_NAME}}', vars)
    expect(r.text).toBe('Hi Pat, thanks for Nova-energy! — Casey')
    expect(r.unresolved).toEqual([])
  })

  it('leaves unknown variables visible and reports them once', () => {
    const r = fillTemplate('Our rate is {{rate}} ({{rate}}) for {{brand}}.', vars)
    expect(r.text).toBe('Our rate is {{rate}} ({{rate}}) for Nova-energy.')
    expect(r.unresolved).toEqual(['rate'])
  })

  it('leaves name variables alone when the recipient is only an address', () => {
    const r = fillTemplate('Hi {{first_name}} ({{email}})', { recipient: 'pat@x.example' })
    expect(r.text).toBe('Hi {{first_name}} (pat@x.example)')
    expect(r.unresolved).toEqual(['first_name'])
  })

  it('knows the date', () => {
    expect(fillTemplate('{{weekday}}, {{date}}', { now: NOW }).text).toBe('Sunday, October 25, 2026')
  })

  it('escapes values for HTML bodies', () => {
    const r = fillTemplate('<p>{{name}}</p>', { recipient: 'A <b> & C <a@x.example>' }, true)
    expect(r.text).not.toContain('<b>')
  })

  it('an explicit brand wins over the guess', () => {
    expect(fillTemplate('{{brand}}', { ...vars, brand: 'Orbit' }).text).toBe('Orbit')
  })
})

describe('placeholders', () => {
  it('detects and lists them', () => {
    expect(hasPlaceholders('no vars {{ x }} here')).toBe(true)
    expect(hasPlaceholders('{ not } {{ 1bad }}')).toBe(false)
    expect(placeholdersIn('{{Rate}} and {{rate}} and {{brand}}')).toEqual(['rate', 'brand'])
  })
  it('variableValues drops what it cannot work out', () => {
    expect(Object.keys(variableValues({ now: NOW })).sort()).toEqual(['date', 'today', 'weekday'])
  })
})
