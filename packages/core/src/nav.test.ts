import { describe, expect, it } from 'vitest'
import { navBack, navCanBack, navCanForward, navCurrent, navFilter, navForward, navPush, navStart } from './nav'

const walk = (...screens: string[]) => screens.slice(1).reduce(navPush, navStart(screens[0]!))

describe('navigation history', () => {
  it('goes back and forward through the screens in order', () => {
    let h = walk('home', 'inbox', 'message')
    expect(navCurrent(h)).toBe('message')
    expect(navCanForward(h)).toBe(false)
    h = navBack(h)
    expect(navCurrent(h)).toBe('inbox')
    expect(navCanForward(h)).toBe(true)
    h = navBack(h)
    expect(navCurrent(h)).toBe('home')
    expect(navCanBack(h)).toBe(false)
    expect(navCurrent(navForward(navForward(h)))).toBe('message')
  })

  it('stays put at either end', () => {
    const h = walk('home', 'inbox')
    expect(navBack(navBack(h))).toEqual(navBack(h))
    expect(navForward(h)).toBe(h)
    expect(navBack(navStart('home'))).toEqual(navStart('home'))
  })

  it('drops what was ahead when something new is opened', () => {
    let h = walk('home', 'inbox', 'message 1')
    h = navBack(h)
    h = navPush(h, 'message 2')
    expect(h.entries).toEqual(['home', 'inbox', 'message 2'])
    expect(navCanForward(h)).toBe(false)
  })

  it('remembers only the last 50 screens', () => {
    let h = navStart('0')
    for (let i = 1; i <= 80; i++) h = navPush(h, String(i))
    expect(h.entries.length).toBe(50)
    expect(navCurrent(h)).toBe('80')
    expect(h.entries[0]).toBe('31')
  })

  it('removes screens that no longer make sense and keeps its place', () => {
    const h = navBack(walk('home', 'inbox:a', 'message:a', 'inbox:b'))
    expect(navCurrent(h)).toBe('message:a')
    const cleaned = navFilter(h, (s) => !s.endsWith(':a'), 'home')
    expect(cleaned.entries).toEqual(['home', 'inbox:b'])
    expect(navCurrent(cleaned)).toBe('inbox:b')
    expect(navFilter(walk('x:a'), (s) => !s.endsWith(':a'), 'home')).toEqual(navStart('home'))
    // The current screen stays current when it is kept.
    expect(navCurrent(navFilter(walk('home', 'inbox:a', 'inbox:b'), (s) => s !== 'inbox:a', 'home'))).toBe('inbox:b')
  })
})
